import { randomUUID } from "node:crypto";
import { KnowledgeBase } from "../src/agent/kb.js";
import type { Proposer } from "../src/agent/proposer.js";
import { RuleProposer } from "../src/agent/rule-proposer.js";
import { FakeHelpdesk } from "../src/channel/channel.js";
import { openDb } from "../src/db/db.js";
import { addSeconds } from "../src/domain.js";
import { ingestMessage, type InboundMessage } from "../src/services/ingest.js";

export const kb = KnowledgeBase.load();

/** Fresh database per test: in-memory PGlite, or its own schema on DATABASE_URL when set (CI runs both). */
export async function makeEnv(proposer: Proposer = new RuleProposer(kb)) {
  const db = await openDb({
    url: process.env.DATABASE_URL,
    schema: process.env.DATABASE_URL ? `t_${randomUUID().replaceAll("-", "")}` : undefined,
  });
  let now = new Date("2026-10-22T09:00:00Z");
  const clock = () => now;
  const env = {
    db,
    proposer,
    channel: new FakeHelpdesk(),
    clock,
    advance: (seconds: number) => {
      now = addSeconds(now, seconds);
    },
    ingest: (m: Partial<InboundMessage> = {}) => ingestMessage(db, message(m), clock),
    one: async <T = Record<string, unknown>>(sql: string, params?: unknown[]) => (await db.query<T>(sql, params))[0]!,
  };
  return env;
}

export const message = (m: Partial<InboundMessage> = {}): InboundMessage => ({
  channel: "email",
  externalTicketId: "T-1",
  externalMessageId: "T-1-m1",
  customerRef: "c-1",
  subject: "Forgot password",
  body: "I forgot my password and the reset email never came.",
  ...m,
});
