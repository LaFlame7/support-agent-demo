import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { openAppDb } from "../app.js";
import { systemClock } from "../domain.js";
import { ApprovalError, approve, reject } from "../services/approvals.js";
import { ingestMessage, type InboundMessage } from "../services/ingest.js";

// Reviewer CLI, standing in for the support agent's UI.
//   npm run review -- ingest examples/ticket.json
//   npm run review -- queue
//   npm run review -- approve 3 --as "Olena" [--reply "edited text"]
//   npm run review -- reject 3 --as "Olena" --note "wrong article"
const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: { as: { type: "string" }, reply: { type: "string" }, note: { type: "string" } },
});
const [command, arg] = positionals;
const db = await openAppDb();

try {
  switch (command) {
    case "ingest": {
      const msg = JSON.parse(readFileSync(arg!, "utf8")) as InboundMessage;
      console.log(await ingestMessage(db, msg, systemClock));
      break;
    }
    case "queue": {
      const rows = await db.query(
        `select p.id, p.ticket_id, p.status, p.category, p.risk_flags, p.draft_reply
         from proposals p where p.status in ('pending_approval', 'escalated') order by p.id`,
      );
      for (const r of rows) console.log(r);
      if (!rows.length) console.log("nothing waiting");
      break;
    }
    case "approve":
      console.log(await approve(db, { proposalId: Number(arg), approver: values.as ?? "", editedReply: values.reply, note: values.note }, systemClock));
      break;
    case "reject":
      await reject(db, { proposalId: Number(arg), approver: values.as ?? "", note: values.note }, systemClock);
      console.log("rejected");
      break;
    default:
      console.log("usage: review <ingest file.json | queue | approve id --as name | reject id --as name>");
  }
} catch (err) {
  if (!(err instanceof ApprovalError)) throw err;
  console.error(`refused (${err.code}): ${err.message}`);
  process.exitCode = 1;
} finally {
  await db.close();
}
