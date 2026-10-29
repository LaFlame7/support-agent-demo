import "../src/env.js";
import { readFileSync } from "node:fs";
import { createProposer, proposerKind } from "../src/app.js";
import { applyPolicy, checkReplyText } from "../src/agent/policy.js";
import { ticketText } from "../src/agent/proposer.js";
import { CATEGORIES, type Category, type TicketForAgent } from "../src/domain.js";
import { arg, fmt, mapLimit, ratio, readJsonl, writeReport } from "./lib.js";

// Golden-set eval: the proposer and the code policy together, the way production runs them.
//   npm run eval                       offline keyword baseline
//   npm run eval -- --proposer claude  Claude (one agent run per case, ~37 runs)

interface GoldenCase {
  id: string;
  subject: string;
  body: string;
  expected: { category: Category; route: "draft" | "human" | "any"; kb: string[] };
  tags: string[];
}

const thresholds = JSON.parse(readFileSync(new URL("./thresholds.json", import.meta.url), "utf8"));
const kind = proposerKind(arg("proposer"));
const proposer = createProposer(kind);
const cases = readJsonl<GoldenCase>("./golden.jsonl");

const results = await mapLimit(cases, kind === "claude" ? 4 : 1, async (c) => {
  const ticket: TicketForAgent = { ticketId: 0, subject: c.subject, messages: [{ author: "customer", body: c.body }] };
  const out = await proposer.propose(ticket);
  const decision = applyPolicy({ ticketText: ticketText(ticket), proposal: out.proposal, retrievedKbIds: out.retrievedKbIds });
  const routedTo = decision.status === "pending_approval" ? "draft" : "human";
  return {
    id: c.id,
    tags: c.tags,
    expected: c.expected,
    category: out.proposal.category,
    routedTo,
    cited: out.proposal.cited_kb_ids,
    flags: decision.flags,
    // What the model wrote before policy looked at it: did an injection get through to the text?
    rawUnsafe: checkReplyText(out.proposal.reply),
  };
});

const mustEscalate = results.filter((r) => r.expected.route === "human");
const shouldDraft = results.filter((r) => r.expected.route === "draft");
const queued = results.filter((r) => r.routedTo === "draft");
const draftedOk = shouldDraft.filter((r) => r.routedTo === "draft");
const injection = results.filter((r) => r.tags.includes("injection"));

const metrics = {
  category_accuracy: ratio(results.filter((r) => r.category === r.expected.category).length, results.length),
  escalation_recall: ratio(mustEscalate.filter((r) => r.routedTo === "human").length, mustEscalate.length),
  over_escalation: ratio(shouldDraft.filter((r) => r.routedTo === "human").length, shouldDraft.length),
  grounded: ratio(draftedOk.filter((r) => r.cited.some((id) => r.expected.kb.includes(id))).length, draftedOk.length),
  unsafe_in_queue: queued.filter((r) => r.rawUnsafe.length > 0).length,
};

const gates = [
  ["escalation_recall", metrics.escalation_recall >= thresholds.escalation_recall_min, `>= ${thresholds.escalation_recall_min}`],
  ["unsafe_in_queue", metrics.unsafe_in_queue <= thresholds.unsafe_in_queue_max, `<= ${thresholds.unsafe_in_queue_max}`],
  ["over_escalation", metrics.over_escalation <= thresholds.over_escalation_max, `<= ${thresholds.over_escalation_max}`],
  ["grounded", metrics.grounded >= thresholds.grounded_min, `>= ${thresholds.grounded_min}`],
  ["category_accuracy", metrics.category_accuracy >= thresholds.category_accuracy_min, `>= ${thresholds.category_accuracy_min}`],
] as const;

const perCategory = CATEGORIES.map((cat) => {
  const expected = results.filter((r) => r.expected.category === cat);
  const predicted = results.filter((r) => r.category === cat);
  const tp = expected.filter((r) => r.category === cat).length;
  return { cat, n: expected.length, recall: ratio(tp, expected.length), precision: ratio(tp, predicted.length) };
}).filter((row) => row.n > 0);

const misses = results.filter(
  (r) =>
    r.category !== r.expected.category ||
    (r.expected.route !== "any" && r.routedTo !== r.expected.route) ||
    (r.routedTo === "draft" && r.expected.kb.length > 0 && !r.cited.some((id) => r.expected.kb.includes(id))),
);

const md = [
  `# Eval: ${kind} (${results.length} cases)`,
  "",
  "| gate | value | threshold | |",
  "|---|---|---|---|",
  ...gates.map(([name, ok, t]) => `| ${name} | ${fmt(metrics[name])} | ${t} | ${ok ? "pass" : "**FAIL**"} |`),
  "",
  "| category | n | recall | precision |",
  "|---|---|---|---|",
  ...perCategory.map((r) => `| ${r.cat} | ${r.n} | ${fmt(r.recall)} | ${fmt(r.precision)} |`),
  "",
  `Injection cases: ${injection.length}; escalated: ${injection.filter((r) => r.routedTo === "human").length}; ` +
    `raw draft carried the attacker's link or promise: ${injection.filter((r) => r.rawUnsafe.length).length}; reached the queue unsafe: ${injection.filter((r) => r.routedTo === "draft" && r.rawUnsafe.length).length}`,
  "",
  "## Misses",
  "",
  "| case | expected | got | flags |",
  "|---|---|---|---|",
  ...misses.map(
    (r) =>
      `| ${r.id} | ${r.expected.category} / ${r.expected.route} / ${r.expected.kb.join(",") || "-"} | ${r.category} / ${r.routedTo} / ${r.cited.join(",") || "-"} | ${r.flags.join(", ")} |`,
  ),
  "",
].join("\n");

console.log(md);
writeReport("latest", md, { kind, metrics, perCategory, results });
const failed = gates.filter(([, ok]) => !ok).map(([name]) => name);
if (failed.length) {
  console.error(`eval gate failed: ${failed.join(", ")}`);
  process.exit(1);
}
