import type { AgentProposal, TicketForAgent } from "../domain.js";

export interface ProposerResult {
  proposal: AgentProposal;
  /** KB ids the agent looked at. Policy rejects citations outside this list. */
  retrievedKbIds: string[];
  model: string;
  promptVersion: string;
  /** Tool calls, stop reasons, token usage: stored with the proposal for debugging and evals. */
  trace: Record<string, unknown>;
}

export interface Proposer {
  propose(ticket: TicketForAgent): Promise<ProposerResult>;
}

/** Customer text rendered as data. Angle brackets are escaped so the text can't close the tag. */
export function renderTicket(ticket: TicketForAgent): string {
  const esc = (s: string) => s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  const messages = ticket.messages
    .map((m) => `<message author="${m.author}">\n${esc(m.body)}\n</message>`)
    .join("\n");
  return `<ticket id="${ticket.ticketId}">\n<subject>${esc(ticket.subject)}</subject>\n${messages}\n</ticket>`;
}

export const ticketText = (t: TicketForAgent) =>
  [t.subject, ...t.messages.filter((m) => m.author === "customer").map((m) => m.body)].join("\n");
