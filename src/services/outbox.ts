import type { ChannelAdapter } from "../channel/channel.js";
import type { Db } from "../db/db.js";
import { addSeconds, type Clock, config } from "../domain.js";
import { audit } from "./audit.js";

export interface SendDeps {
  db: Db;
  channel: ChannelAdapter;
  clock: Clock;
  /** Test seam: runs after the helpdesk accepted the reply and before we record it. */
  afterDeliver?: (job: OutboxJob) => Promise<void>;
}

export interface OutboxJob {
  id: number;
  proposal_id: number;
  ticket_id: number;
  idempotency_key: string;
  body: string;
  attempts: number;
  channel: string;
  external_id: string;
}

export type SendOutcome = "sent" | "retry" | "dead" | "lost_lease";

/**
 * At-least-once delivery turned into exactly-once replies:
 * - a leased claim, so one worker owns a job at a time and a dead worker's job comes back;
 * - before re-sending, ask the channel whether this key already went out
 *   (the crash window is "delivered, but not recorded yet");
 * - record the result fenced on the attempt number, so a worker whose lease
 *   expired can't overwrite the newer attempt.
 * Invariant: lease length > channel send timeout.
 */
export async function sendNext({ db, channel, clock, afterDeliver }: SendDeps): Promise<SendOutcome | null> {
  const now = clock();
  const [job] = await db.query<OutboxJob>(
    `with claimed as (
       update outbox set status = 'sending', attempts = attempts + 1, lease_until = $2
       where id = (
         select id from outbox
         where (status = 'pending' and next_attempt_at <= $1)
            or (status = 'sending' and lease_until < $1)
         order by id
         limit 1
         for update skip locked
       )
       returning id, proposal_id, ticket_id, idempotency_key, body, attempts
     )
     select c.*, t.channel, t.external_id from claimed c join tickets t on t.id = c.ticket_id`,
    [now, addSeconds(now, config.leaseSeconds)],
  );
  if (!job) return null;

  let providerMessageId: string;
  let reconciled = false;
  try {
    const previous = job.attempts > 1 ? await channel.findByIdempotencyKey(job.idempotency_key) : null;
    reconciled = previous !== null;
    providerMessageId =
      previous?.providerMessageId ??
      (
        await channel.send({
          idempotencyKey: job.idempotency_key,
          channel: job.channel,
          ticketExternalId: job.external_id,
          body: job.body,
        })
      ).providerMessageId;
  } catch (err) {
    return scheduleRetry(db, job, err, clock());
  }

  await afterDeliver?.(job);

  return db.tx(async (q) => {
    const at = clock();
    const updated = await q.query(
      `update outbox set status = 'sent', provider_message_id = $3, sent_at = $4, lease_until = null, last_error = null
       where id = $1 and attempts = $2 and status = 'sending'
       returning id`,
      [job.id, job.attempts, providerMessageId, at],
    );
    if (!updated.length) return "lost_lease";
    await q.query(
      `update tickets t set status = 'replied', updated_at = $2
       from proposals p
       where p.id = $1 and t.id = p.ticket_id and t.version = p.ticket_version`,
      [job.proposal_id, at],
    );
    await audit(q, {
      entity: "outbox",
      entityId: job.id,
      action: "sent",
      actor: "worker",
      details: { provider_message_id: providerMessageId, attempt: job.attempts, reconciled },
      at,
    });
    return "sent";
  });
}

async function scheduleRetry(db: Db, job: OutboxJob, err: unknown, now: Date): Promise<SendOutcome> {
  const dead = job.attempts >= config.maxSendAttempts;
  return db.tx(async (q) => {
    const updated = await q.query(
      `update outbox set status = $3, lease_until = null, next_attempt_at = $4, last_error = $5
       where id = $1 and attempts = $2 and status = 'sending'
       returning id`,
      [job.id, job.attempts, dead ? "dead" : "pending", addSeconds(now, Math.min(2 ** job.attempts * 5, 600)), String(err)],
    );
    if (!updated.length) return "lost_lease";
    if (dead) {
      await q.query("update tickets set status = 'human_handling', updated_at = $2 where id = $1", [job.ticket_id, now]);
    }
    await audit(q, {
      entity: "outbox",
      entityId: job.id,
      action: dead ? "dead" : "send_failed",
      actor: "worker",
      details: { attempt: job.attempts, error: String(err) },
      at: now,
    });
    return dead ? "dead" : "retry";
  });
}
