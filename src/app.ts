import { mkdirSync } from "node:fs";
import { ClaudeProposer } from "./agent/claude-proposer.js";
import { KnowledgeBase } from "./agent/kb.js";
import type { Proposer } from "./agent/proposer.js";
import { RuleProposer } from "./agent/rule-proposer.js";
import { openDb } from "./db/db.js";

export type ProposerKind = "rules" | "claude";

export function proposerKind(arg?: string): ProposerKind {
  const kind = arg ?? process.env.PROPOSER ?? "rules";
  if (kind !== "rules" && kind !== "claude") throw new Error(`unknown proposer "${kind}" (rules | claude)`);
  if (kind === "claude" && !process.env.ANTHROPIC_API_KEY) throw new Error("PROPOSER=claude needs ANTHROPIC_API_KEY");
  return kind;
}

export function createProposer(kind: ProposerKind, kb = KnowledgeBase.load()): Proposer {
  return kind === "claude" ? new ClaudeProposer(kb) : new RuleProposer(kb);
}

export function openAppDb() {
  if (process.env.DATABASE_URL) return openDb({ url: process.env.DATABASE_URL });
  mkdirSync(".data", { recursive: true });
  return openDb({ dir: process.env.PGLITE_DIR || ".data/pglite" });
}
