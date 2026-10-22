import { afterEach, describe, expect, it } from "vitest";
import { config } from "../src/domain.js";
import { ApprovalError, approve, reject } from "../src/services/approvals.js";
import { draftNext } from "../src/services/drafting.js";
import { sendNext } from "../src/services/outbox.js";
import { tick } from "../src/worker.js";
import { RuleProposer } from "../src/agent/rule-proposer.js";
import { kb, makeEnv } from "./helpers.js";

type Env = Awaited<ReturnType<typeof makeEnv>>;
let env: Env;
afterEach(() => env?.db.close());

async function pendingProposal(e: Env) {
  await e.ingest();
  await tick(e);
  return e.one<{ id: number; status: string }>("select id, status from proposals order by id desc limit 1");
}

const code = (p: Promise<unknown>) => p.then(() => "ok", (e: ApprovalError) => e.code);

describe("ingest", () => {
  it("dedupes webhook retries of the same message", async () => {
    env = await makeEnv();
    expect((await env.ingest()).outcome).toBe("created");
    expect((await env.ingest()).outcome).toBe("duplicate");
    expect(await env.one("select count(*)::int as n from messages")).toEqual({ n: 1 });
  });

  it("a follow-up invalidates the draft waiting for approval", async () => {
    env = await makeEnv();
    const p = await pendingProposal(env);
    expect(p.status).toBe("pending_approval");

    await env.ingest({ externalMessageId: "T-1-m2", body: "Also, the link in the email says expired." });
    expect(await code(approve(env.db, { proposalId: p.id, approver: "Olena" }, env.clock))).toBe("stale");
    expect(await env.one("select status from proposals where id = $1", [p.id])).toEqual({ status: "superseded" });

    await tick(env);
    const next = await env.one<{ ticket_version: number; status: string }>(
      "select ticket_version, status from proposals order by id desc limit 1",
    );
    expect(next).toEqual({ ticket_version: 2, status: "pending_approval" });
  });
});

describe("approval", () => {
  it("needs a named person", async () => {
    env = await makeEnv();
    const p = await pendingProposal(env);
    expect(await code(approve(env.db, { proposalId: p.id, approver: "   " }, env.clock))).toBe("invalid_approver");
    // The database enforces it too, not just the service.
    await expect(env.db.query("update proposals set status = 'approved', final_reply = 'x' where id = $1", [p.id])).rejects.toThrow();
  });

  it("two approvers at once: one wins, one reply is queued", async () => {
    env = await makeEnv();
    const p = await pendingProposal(env);
    const outcomes = await Promise.all([
      code(approve(env.db, { proposalId: p.id, approver: "Olena" }, env.clock)),
      code(approve(env.db, { proposalId: p.id, approver: "Andrii" }, env.clock)),
    ]);
    expect(outcomes.sort()).toEqual(["not_pending", "ok"]);
    expect(await env.one("select count(*)::int as n from outbox")).toEqual({ n: 1 });
  });

  it("escalated drafts can't be approved", async () => {
    env = await makeEnv();
    await env.ingest({ subject: "Refund", body: "I was charged twice, I want my money back." });
    await tick(env);
    const p = await env.one<{ id: number; status: string }>("select id, status from proposals");
    expect(p.status).toBe("escalated");
    expect(await code(approve(env.db, { proposalId: p.id, approver: "Olena" }, env.clock))).toBe("not_pending");
  });

  it("an edited reply goes through the same output checks", async () => {
    env = await makeEnv();
    const p = await pendingProposal(env);
    const edited = "Sure, we will refund you today. Details: https://bit.ly/x";
    expect(await code(approve(env.db, { proposalId: p.id, approver: "Olena", editedReply: edited }, env.clock))).toBe(
      "reply_blocked",
    );
  });

  it("rejecting hands the ticket to a person and queues nothing", async () => {
    env = await makeEnv();
    const p = await pendingProposal(env);
    await reject(env.db, { proposalId: p.id, approver: "Olena", note: "wrong article" }, env.clock);
    expect(await env.one("select status from tickets")).toEqual({ status: "human_handling" });
    expect(await env.one("select count(*)::int as n from outbox")).toEqual({ n: 0 });
  });
});

describe("sending", () => {
  it("crash after delivery, before recording: the restarted worker doesn't send again", async () => {
    env = await makeEnv();
    const p = await pendingProposal(env);
    await approve(env.db, { proposalId: p.id, approver: "Olena" }, env.clock);

    const crash = async () => {
      throw new Error("killed");
    };
    await expect(sendNext({ ...env, afterDeliver: crash })).rejects.toThrow("killed");
    expect(env.channel.sent).toHaveLength(1);

    // Lease still held: nobody else touches the job.
    expect(await sendNext(env)).toBeNull();

    env.advance(config.leaseSeconds + 1);
    expect(await sendNext(env)).toBe("sent");
    expect(env.channel.sent).toHaveLength(1);
    expect(await env.one("select status, attempts, provider_message_id from outbox")).toEqual({
      status: "sent",
      attempts: 2,
      provider_message_id: "hd_1",
    });
    expect(await env.one("select status from tickets")).toEqual({ status: "replied" });
  });

  it("a worker that lost its lease can't record over the newer attempt", async () => {
    env = await makeEnv();
    const p = await pendingProposal(env);
    await approve(env.db, { proposalId: p.id, approver: "Olena" }, env.clock);

    let resumeSlowWorker!: () => void;
    const slow = sendNext({ ...env, afterDeliver: () => new Promise<void>((r) => (resumeSlowWorker = r)) });
    await new Promise((r) => setTimeout(r, 50));

    env.advance(config.leaseSeconds + 1);
    expect(await sendNext(env)).toBe("sent");
    resumeSlowWorker();
    expect(await slow).toBe("lost_lease");
    expect(env.channel.sent).toHaveLength(1);
  });

  it("retries transient failures with backoff, then gives up and hands over", async () => {
    env = await makeEnv();
    const p = await pendingProposal(env);
    await approve(env.db, { proposalId: p.id, approver: "Olena" }, env.clock);

    env.channel.failNextSends(1);
    expect(await sendNext(env)).toBe("retry");
    expect(await sendNext(env)).toBeNull(); // backing off
    env.advance(3600);
    expect(await sendNext(env)).toBe("sent");

    const q = await pendingProposal({ ...env, ingest: () => env.ingest({ externalTicketId: "T-2", externalMessageId: "T-2-m1" }) });
    await approve(env.db, { proposalId: q.id, approver: "Olena" }, env.clock);
    env.channel.failNextSends(100);
    const outcomes = [];
    for (let i = 0; i < config.maxSendAttempts; i++) {
      outcomes.push(await sendNext(env));
      env.advance(3600);
    }
    expect(outcomes.at(-1)).toBe("dead");
    expect(await env.one("select status from tickets where external_id = 'T-2'")).toEqual({ status: "human_handling" });
  });
});

describe("drafting", () => {
  it("a worker dying mid-draft leaves no duplicate proposal", async () => {
    let calls = 0;
    const base = new RuleProposer(kb);
    env = await makeEnv({
      propose: (t) => (++calls === 1 ? new Promise(() => {}) : base.propose(t)), // first call never returns
    });
    await env.ingest();
    void draftNext(env); // the "dead" worker
    await new Promise((r) => setTimeout(r, 50));
    expect(await draftNext(env)).toBeNull(); // lease held

    env.advance(config.leaseSeconds + 1);
    expect(await draftNext(env)).toBe("proposed");
    expect(await env.one("select count(*)::int as n from proposals")).toEqual({ n: 1 });
  });

  it("model errors are retried, then the ticket goes to a person", async () => {
    env = await makeEnv({ propose: () => Promise.reject(new Error("overloaded")) });
    await env.ingest();
    const outcomes = [];
    for (let i = 0; i < config.maxDraftAttempts; i++) {
      outcomes.push(await draftNext(env));
      env.advance(3600);
    }
    expect(outcomes).toEqual(["retry", "retry", "gave_up"]);
    expect(await env.one("select status from tickets")).toEqual({ status: "human_handling" });
  });
});
