import "../src/env.js";
import { KnowledgeBase } from "../src/agent/kb.js";
import { ClaudeJudge, HeuristicJudge, type Judge } from "./judges.js";
import { arg, fmt, mapLimit, ratio, readJsonl, writeReport } from "./lib.js";

// Before a judge scores anything unattended, measure it against human labels.
//   npm run judge:calibrate                       heuristic judge (offline)
//   npm run judge:calibrate -- --judge claude     Claude as judge (24 calls)
//   add --gate to exit 1 when the judge isn't trustworthy

interface Label {
  id: string;
  question: string;
  reply: string;
  kb: string[];
  human: "pass" | "fail";
  why: string;
}

const MIN_KAPPA = 0.6;
const MIN_FAIL_RECALL = 0.8;

const kb = KnowledgeBase.load();
const which = arg("judge") ?? "heuristic";
if (which === "claude" && !process.env.ANTHROPIC_API_KEY) throw new Error("--judge claude needs ANTHROPIC_API_KEY");
const judge: Judge = which === "claude" ? new ClaudeJudge(kb) : new HeuristicJudge(kb);
const labels = readJsonl<Label>("./judge-labels.jsonl");

const rows = await mapLimit(labels, which === "claude" ? 4 : 1, async (l) => ({ ...l, ...(await judge.judge(l)) }));
const scored = rows.filter((r) => r.verdict !== "abstain");

// Positive class = "fail": the judge exists to catch bad drafts.
const tp = scored.filter((r) => r.verdict === "fail" && r.human === "fail").length;
const tn = scored.filter((r) => r.verdict === "pass" && r.human === "pass").length;
const fp = scored.filter((r) => r.verdict === "fail" && r.human === "pass").length;
const fn = scored.filter((r) => r.verdict === "pass" && r.human === "fail").length;
const n = scored.length;

const agreement = ratio(tp + tn, n);
const chance = ratio((tp + fp) * (tp + fn) + (tn + fn) * (tn + fp), n * n);
const kappa = chance === 1 ? 1 : (agreement - chance) / (1 - chance);
const failRecall = ratio(tp, tp + fn);
const failPrecision = ratio(tp, tp + fp);
const trusted = kappa >= MIN_KAPPA && failRecall >= MIN_FAIL_RECALL;

const md = [
  `# Judge calibration: ${judge.name} vs human labels (${labels.length} items)`,
  "",
  `| metric | value |`,
  `|---|---|`,
  `| agreement | ${fmt(agreement)} |`,
  `| Cohen's kappa | ${fmt(kappa)} (need >= ${MIN_KAPPA}) |`,
  `| recall on human "fail" | ${fmt(failRecall)} (need >= ${MIN_FAIL_RECALL}) |`,
  `| precision on "fail" | ${fmt(failPrecision)} |`,
  `| abstained | ${rows.length - n} |`,
  "",
  `|  | human fail | human pass |`,
  `|---|---|---|`,
  `| judge fail | ${tp} | ${fp} |`,
  `| judge pass | ${fn} | ${tn} |`,
  "",
  trusted
    ? "Verdict: **trusted** for this rubric. Re-calibrate when the prompt, model or rubric changes."
    : "Verdict: **not trusted**. Don't let it score drafts unattended; see disagreements below.",
  "",
  "## Disagreements",
  "",
  "| id | human | judge | human note | judge reason |",
  "|---|---|---|---|---|",
  ...rows
    .filter((r) => r.verdict !== r.human)
    .map((r) => `| ${r.id} | ${r.human} | ${r.verdict} | ${r.why} | ${r.reason.replaceAll("|", "/")} |`),
  "",
].join("\n");

console.log(md);
writeReport(`latest-judge-${judge.name}`, md, { judge: judge.name, agreement, kappa, failRecall, failPrecision, rows });
if (process.argv.includes("--gate") && !trusted) process.exit(1);
