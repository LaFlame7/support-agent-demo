import type { Db } from "../db/db.js";
import { applyPolicy } from "../agent/policy.js";
import { type Proposer, ticketText } from "../agent/proposer.js";
import { addSeconds, type Clock, config, type TicketForAgent } from "../domain.js";
import { audit } from "./audit.js";

export interface DraftDeps {
  db: Db;
  proposer: Proposer;
  clock: Clock;
}

export type DraftOutcome = "proposed" | "escalated" | "stale" | "retry" | "gave_up";

/**
 * Claims one ticket that needs a draft, asks the agent, runs policy, stores the
 * proposal. The LLM call happens outside any transaction; the lease covers it.
 * If this process dies mid-call, the lease expires and another worker redoes it.
 */
export async function draftNext({ db, proposer, clock }: DraftDeps): Promise<DraftOutcome | null> {
  const now = clock();
  const [ticket] = await db.query<{ id: number; version: number; subject: string; attempts: number }>(
    `update tickets set status = 'drafting', lease_until = $2, attempts = attempts + 1, updated_at = $1
     where id = (
       select id from tickets
       where (status = 'new' and (lease_until is null or lease_until < $1))
          or (status = 'drafting' and lease_until < $1)
       order by updated_at
       limit 1
       for update skip locked
     )
     returning id, version, subject, attempts`,
    [now, addSeconds(now, config.leaseSeconds)],
  );
  if (!ticket) return null;

  const messages = await db.query<TicketForAgent["messages"][number]>(
    "select author, body from messages where ticket_id = $1 order by id",
    [ticket.id],
  );
  const input: TicketForAgent = { ticketId: ticket.id, subject: ticket.subject, messages };

  let result;
  try {
    result = await proposer.propose(input);
  } catch (err) {
    return failAttempt(db, ticket, err, clock());
  }
  const decision = applyPolicy({
    ticketText: ticketText(input),
    proposal: result.proposal,
    retrievedKbIds: result.retrievedKbIds,
  });

  return db.tx(async (q) => {
    const at = clock();
    const [current] = await q.query<{ version: number; status: string }>(
      "select version, status from tickets where id = $1 for update",
      [ticket.id],
    );
    // The customer wrote again while we were drafting: this draft answers an old question.
    if (current!.version !== ticket.version || current!.status !== "drafting") return "stale";

    const inserted = await q.query<{ id: number }>(
      `insert into proposals (ticket_id, ticket_version, status, category, draft_reply, cited_kb_ids,
                              risk_flags, model, prompt_version, trace, created_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       on conflict (ticket_id, ticket_version) do nothing
       returning id`,
      [
        ticket.id,
        ticket.version,
        decision.status,
        result.proposal.category,
        result.proposal.reply,
        JSON.stringify(result.proposal.cited_kb_ids),
        JSON.stringify(decision.flags),
        result.model,
        result.promptVersion,
        JSON.stringify({ ...result.trace, needs_human_reason: result.proposal.needs_human_reason }),
        at,
      ],
    );
    await q.query("update tickets set status = $2, lease_until = null, updated_at = $3 where id = $1", [
      ticket.id,
      decision.status === "pending_approval" ? "awaiting_approval" : "human_handling",
      at,
    ]);
    if (inserted.length) {
      await audit(q, {
        entity: "proposal",
        entityId: inserted[0]!.id,
        action: decision.status,
        actor: `agent:${result.model}`,
        details: { ticket_id: ticket.id, category: result.proposal.category, flags: decision.flags },
        at,
      });
    }
    return decision.status === "pending_approval" ? "proposed" : "escalated";
  });
}

async function failAttempt(
  db: Db,
  ticket: { id: number; version: number; attempts: number },
  err: unknown,
  now: Date,
): Promise<DraftOutcome> {
  const gaveUp = ticket.attempts >= config.maxDraftAttempts;
  await db.tx(async (q) => {
    await q.query(
      `update tickets set status = $3, lease_until = $4, updated_at = $5
       where id = $1 and version = $2 and status = 'drafting'`,
      [ticket.id, ticket.version, gaveUp ? "human_handling" : "new", gaveUp ? null : addSeconds(now, 30 * 2 ** ticket.attempts), now],
    );
    await audit(q, {
      entity: "ticket",
      entityId: ticket.id,
      action: gaveUp ? "drafting_gave_up" : "drafting_failed",
      actor: "worker",
      details: { attempt: ticket.attempts, error: String(err) },
      at: now,
    });
  });
  return gaveUp ? "gave_up" : "retry";
}
