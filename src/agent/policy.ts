import { type AgentProposal, config, HUMAN_ONLY_CATEGORIES } from "../domain.js";

/**
 * Code-level rules applied after the model, whatever the model said.
 * The model can't argue with these, and a prompt injection can't switch them off.
 */
export interface PolicyInput {
  ticketText: string;
  proposal: AgentProposal;
  /** KB ids the agent actually retrieved during this run. */
  retrievedKbIds: string[];
}

export interface PolicyDecision {
  status: "pending_approval" | "escalated";
  flags: string[];
}

// Don't trust the classifier alone for the cases that cost money or break the law.
const RISK_PATTERNS: [string, RegExp][] = [
  [
    "money_mentioned",
    /\b(refund|money back|chargeback|charged twice|double charged?|reimburse|took (a|another|the) payment|payment returned|return (the|my|that) payment)/i,
  ],
  ["privacy_request", /\b(gdpr|delete (my|the)? ?(account|data|profile)|erase my|personal data|data export)/i],
  ["legal_threat", /\b(lawyer|attorney|legal action|sue|court|consumer protection)/i],
];

const INJECTION_PATTERNS = [
  /ignore (all |any |the )?(previous|prior|above|earlier) (instructions|rules|messages)/i,
  /disregard (your|the|all) (instructions|rules|policy|guidelines)/i,
  /(system|developer) (prompt|message|mode)/i,
  /you are now\b/i,
  /<\/?(system|instructions?|ticket|assistant)>/i,
  /\b(new|updated) instructions?\b/i,
  /\bpretend (to be|you are)\b/i,
];

// Phrases that commit the company to something only a human may decide.
const PROMISE_PATTERNS = [
  /\b(we('ll| will)|i('ll| will)|i have|we have|i've|we've) (issue|process|refund|credit|reimburse|extend|delete|waive)/i,
  /\byou('ll| will) (get|receive) (a |your )?(refund|credit|money)/i,
  /\b(refund|credit) (has been|is being|was) (issued|processed|approved)/i,
];

export function detectInjection(text: string): boolean {
  return INJECTION_PATTERNS.some((p) => p.test(text));
}

export function applyPolicy({ ticketText, proposal, retrievedKbIds }: PolicyInput): PolicyDecision {
  const flags: string[] = [];

  if (HUMAN_ONLY_CATEGORIES.includes(proposal.category)) flags.push(`human_only_category:${proposal.category}`);
  for (const [flag, pattern] of RISK_PATTERNS) if (pattern.test(ticketText)) flags.push(flag);
  if (detectInjection(ticketText)) flags.push("injection_suspected");
  if (proposal.needs_human) flags.push("model_requested_human");

  const reply = proposal.reply.trim();
  if (!proposal.needs_human) {
    if (reply.length < 20) flags.push("empty_reply");
    if (proposal.cited_kb_ids.length === 0) flags.push("ungrounded_reply");
    const unretrieved = proposal.cited_kb_ids.filter((id) => !retrievedKbIds.includes(id));
    if (unretrieved.length) flags.push(`citation_not_retrieved:${unretrieved.join(",")}`);
  }
  for (const host of linkHosts(reply)) {
    if (!config.allowedLinkHosts.includes(host)) flags.push(`disallowed_link:${host}`);
  }
  if (PROMISE_PATTERNS.some((p) => p.test(reply))) flags.push("commitment_in_reply");

  return { status: flags.length ? "escalated" : "pending_approval", flags };
}

/** The same output checks, for a reply an approver edited by hand. */
export function checkReplyText(reply: string): string[] {
  const flags = linkHosts(reply)
    .filter((h) => !config.allowedLinkHosts.includes(h))
    .map((h) => `disallowed_link:${h}`);
  if (PROMISE_PATTERNS.some((p) => p.test(reply))) flags.push("commitment_in_reply");
  return flags;
}

function linkHosts(text: string): string[] {
  const hosts: string[] = [];
  for (const m of text.matchAll(/\bhttps?:\/\/[^\s)>\]"']+|\bwww\.[^\s)>\]"']+/gi)) {
    try {
      hosts.push(new URL(m[0].startsWith("http") ? m[0] : `https://${m[0]}`).hostname.toLowerCase());
    } catch {
      hosts.push("unparseable");
    }
  }
  return hosts;
}
