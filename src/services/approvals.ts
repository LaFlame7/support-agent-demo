import type { Db, Queryable } from "../db/db.js";
import { checkReplyText } from "../agent/policy.js";
import type { Clock } from "../domain.js";
import { audit } from "./audit.js";

export class ApprovalError extends Error {
  constructor(
    readonly code: "invalid_approver" | "not_found" | "not_pending" | "stale" | "reply_blocked",
    message: string,
  ) {
    super(message);
  }
}

export interface Decision {
  proposalId: number;
  /** In a real app this comes from the authenticated session, never from the request body. */
  approver: string;
  note?: string;
}

/**
 * The only way a reply gets queued for sending. Approval and the outbox row are
 * written in one transaction, so there is no approved-but-never-sent state and
 * no sent-without-approval state.
 */
export async function approve(db: Db, d: Decision & { editedReply?: string }, clock: Clock) {
  const approver = requireName(d.approver);
  const editedReply = d.editedReply?.trim();
  if (editedReply) {
    const flags = checkReplyText(editedReply);
    if (flags.length) throw new ApprovalError("reply_blocked", `edited reply blocked: ${flags.join(", ")}`);
  }

  return db.tx(async (q) => {
    const now = clock();
    const p = await lockPending(q, d.proposalId);
    const finalReply = editedReply || p.draft_reply;

    await q.query(
      `update proposals set status = 'approved', final_reply = $2, decided_by = $3, decided_at = $4, decision_note = $5
       where id = $1 and status = 'pending_approval'`,
      [p.id, finalReply, approver, now, d.note ?? null],
    );
    const [outbox] = await q.query<{ id: number }>(
      `insert into outbox (proposal_id, ticket_id, idempotency_key, body, next_attempt_at, created_at)
       values ($1, $2, $3, $4, $5, $5)
       returning id`,
      [p.id, p.ticket_id, `reply-for-proposal-${p.id}`, finalReply, now],
    );
    await audit(q, {
      entity: "proposal",
      entityId: p.id,
      action: "approved",
      actor: approver,
      details: { edited: finalReply !== p.draft_reply, outbox_id: outbox!.id },
      at: now,
    });
    return { outboxId: outbox!.id };
  });
}

export async function reject(db: Db, d: Decision, clock: Clock) {
  const approver = requireName(d.approver);
  await db.tx(async (q) => {
    const now = clock();
    const p = await lockPending(q, d.proposalId);
    await q.query(
      `update proposals set status = 'rejected', decided_by = $2, decided_at = $3, decision_note = $4
       where id = $1 and status = 'pending_approval'`,
      [p.id, approver, now, d.note ?? null],
    );
    await q.query("update tickets set status = 'human_handling', updated_at = $2 where id = $1", [p.ticket_id, now]);
    await audit(q, { entity: "proposal", entityId: p.id, action: "rejected", actor: approver, details: { note: d.note }, at: now });
  });
}

function requireName(name: string) {
  const trimmed = name.trim();
  if (!trimmed) throw new ApprovalError("invalid_approver", "a decision needs the name of the person making it");
  return trimmed;
}

type LockedProposal = { id: number; status: string; ticket_id: number; ticket_version: number; draft_reply: string; current_version: number };

/** Row lock serialises two approvers clicking at the same moment: the second sees not_pending. */
async function lockPending(q: Queryable, proposalId: number): Promise<LockedProposal> {
  const [p] = await q.query<LockedProposal>(
    `select p.id, p.status, p.ticket_id, p.ticket_version, p.draft_reply, t.version as current_version
     from proposals p join tickets t on t.id = p.ticket_id
     where p.id = $1
     for update of p, t`,
    [proposalId],
  );
  if (!p) throw new ApprovalError("not_found", `proposal ${proposalId} not found`);
  if (p.current_version !== p.ticket_version) {
    throw new ApprovalError("stale", "the customer wrote again after this draft; review the new draft instead");
  }
  if (p.status !== "pending_approval") throw new ApprovalError("not_pending", `proposal is ${p.status}`);
  return p;
}
