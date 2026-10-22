import { z } from "zod";

export const CATEGORIES = [
  "account_access",
  "billing",
  "refund_request",
  "certificate",
  "course_content",
  "technical_issue",
  "privacy_request",
  "other",
] as const;
export type Category = (typeof CATEGORIES)[number];

/** Categories the agent may classify but never draft a customer-facing answer for. */
export const HUMAN_ONLY_CATEGORIES: readonly Category[] = ["refund_request", "privacy_request"];

/** What the model hands back. Validated with Zod no matter where it came from. */
export const AgentProposal = z.object({
  category: z.enum(CATEGORIES),
  reply: z.string().max(2000),
  cited_kb_ids: z.array(z.string()).max(5),
  needs_human: z.boolean(),
  needs_human_reason: z.string().max(500),
});
export type AgentProposal = z.infer<typeof AgentProposal>;

export interface TicketForAgent {
  ticketId: number;
  subject: string;
  messages: { author: "customer" | "agent"; body: string }[];
}

export type Clock = () => Date;
export const systemClock: Clock = () => new Date();

export const config = {
  model: process.env.MODEL || "claude-opus-5-5",
  leaseSeconds: Number(process.env.LEASE_SECONDS ?? 60),
  maxDraftAttempts: 3,
  maxSendAttempts: Number(process.env.MAX_SEND_ATTEMPTS ?? 5),
  /** Hosts a reply may link to. Anything else in a draft blocks it. */
  allowedLinkHosts: ["help.acme-learn.example", "acme-learn.example"],
};

export const addSeconds = (d: Date, s: number) => new Date(d.getTime() + s * 1000);
