import { createProposer, openAppDb, proposerKind } from "../app.js";
import { FakeHelpdesk } from "../channel/channel.js";
import { systemClock } from "../domain.js";
import { tick } from "../worker.js";

// Long-running worker. Kill it at any moment and start it again: nothing is lost or sent twice.
const db = await openAppDb();
const channel = new FakeHelpdesk(".data/helpdesk.jsonl");
const deps = { db, proposer: createProposer(proposerKind()), channel, clock: systemClock };

// --once: a single pass, handy for scripts and cron-style deployments.
const once = process.argv.includes("--once");
let stopping = false;
process.on("SIGINT", () => (stopping = true));
process.on("SIGTERM", () => (stopping = true));

if (!once) console.log("worker started, Ctrl+C to stop");
do {
  const { drafted, sent } = await tick(deps);
  if (drafted.length || sent.length || once) console.log(new Date().toISOString(), { drafted, sent });
  if (!once) await new Promise((r) => setTimeout(r, 1000));
} while (!stopping && !once);
await db.close();
