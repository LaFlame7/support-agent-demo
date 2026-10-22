import { type Category, HUMAN_ONLY_CATEGORIES, type TicketForAgent } from "../domain.js";
import type { KnowledgeBase } from "./kb.js";
import { type Proposer, type ProposerResult, ticketText } from "./proposer.js";

/**
 * Deterministic keyword baseline. Runs offline, so tests, the demo and CI evals
 * need no API key. It is also the bar the LLM has to beat on the golden set.
 */
const RULES: [Category, RegExp][] = [
  ["privacy_request", /\b(gdpr|delete (my )?(account|data)|erase|personal data|data export)/i],
  ["refund_request", /\b(refund|money back|chargeback|charged twice|double charged?)/i],
  ["certificate", /\bcertificate/i],
  ["account_access", /\b(password|log ?in|sign ?in|locked|sso|reset link)/i],
  ["billing", /\b(invoice|receipt|vat|plan|subscription|renew|cancel)/i],
  ["technical_issue", /\b(video|buffer|app|offline|download|crash|error|loading)/i],
  ["course_content", /\b(deadline|quiz|grade|exam|assignment|extension)/i],
];

export class RuleProposer implements Proposer {
  constructor(private readonly kb: KnowledgeBase) {}

  async propose(ticket: TicketForAgent): Promise<ProposerResult> {
    const text = ticketText(ticket);
    const category = RULES.find(([, re]) => re.test(text))?.[0] ?? "other";
    const hits = this.kb.search(text).filter((h) => h.category === category);
    const top = hits[0];
    const needsHuman = HUMAN_ONLY_CATEGORIES.includes(category) || !top;

    return {
      proposal: {
        category,
        reply: needsHuman ? "" : `Hi! ${firstSentences(top!.body, 3)}\n\nLet me know if that doesn't solve it.`,
        cited_kb_ids: needsHuman ? [] : [top!.id],
        needs_human: needsHuman,
        needs_human_reason: needsHuman ? (top ? `category ${category} is handled by a person` : "no matching article") : "",
      },
      retrievedKbIds: hits.map((h) => h.id),
      model: "rules",
      promptVersion: "rules-v1",
      trace: { hits: hits.map((h) => [h.id, h.score]) },
    };
  }
}

const firstSentences = (text: string, n: number) => text.split(/(?<=[.!?])\s+/).slice(0, n).join(" ");
