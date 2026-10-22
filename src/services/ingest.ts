import type { Db } from "../db/db.js";
import type { Clock } from "../domain.js";
import { audit } from "./audit.js";

export interface InboundMessage {
  channel: string;
  externalTicketId: string;
  externalMessageId: string;
  customerRef: string;
  subject: string;
  body: string;
}

export type IngestResult = { ticketId: number; outcome: "created" | "follow_up" | "duplicate" };

/**
 * Webhook handler body. Safe to call any number of times for the same message.
 * A follow-up from the customer bumps the ticket version, which invalidates any
 * draft still waiting for approval.
 */
export function ingestMessage(db: Db, msg: InboundMessage, clock: Clock): Promise<IngestResult> {
  return db.tx(async (q) => {
    const now = clock();
    const created = await q.query<{ id: number }>(
      `insert into tickets (channel, external_id, customer_ref, subject, created_at, updated_at)
       values ($1, $2, $3, $4, $5, $5)
       on conflict (channel, external_id) do nothing
       returning id`,
      [msg.channel, msg.externalTicketId, msg.customerRef, msg.subject, now],
    );
    const [ticket] = created.length
      ? created
      : await q.query<{ id: number }>("select id from tickets where channel = $1 and external_id = $2 for update", [
          msg.channel,
          msg.externalTicketId,
        ]);
    const ticketId = ticket!.id;

    const inserted = await q.query(
      `insert into messages (ticket_id, external_message_id, author, body, created_at)
       values ($1, $2, 'customer', $3, $4)
       on conflict (ticket_id, external_message_id) do nothing
       returning id`,
      [ticketId, msg.externalMessageId, msg.body, now],
    );
    if (!inserted.length) return { ticketId, outcome: "duplicate" };

    if (created.length) {
      await audit(q, { entity: "ticket", entityId: ticketId, action: "created", actor: "webhook", at: now });
      return { ticketId, outcome: "created" };
    }

    // Once a person owns the ticket, the agent stays out of it.
    await q.query(
      `update tickets
       set version = version + 1,
           status = case when status = 'human_handling' then status else 'new' end,
           lease_until = null, attempts = 0, updated_at = $2
       where id = $1`,
      [ticketId, now],
    );
    const superseded = await q.query(
      "update proposals set status = 'superseded' where ticket_id = $1 and status = 'pending_approval' returning id",
      [ticketId],
    );
    await audit(q, {
      entity: "ticket",
      entityId: ticketId,
      action: "follow_up",
      actor: "webhook",
      details: { superseded_proposals: superseded.map((r) => r.id) },
      at: now,
    });
    return { ticketId, outcome: "follow_up" };
  });
}
