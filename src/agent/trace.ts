// Readable view of proposals.trace: what the agent did, turn by turn.
// Used by the demo and `npm run review -- trace <id>`; the raw JSON stays in the table.

interface TurnStep {
  turn: number;
  stop_reason: string;
  served_by: string;
  ms?: number;
  input_tokens?: number;
  output_tokens?: number;
}

interface ToolStep {
  tool: string;
  input: Record<string, unknown>;
  result?: unknown;
}

export function formatTrace(trace: Record<string, unknown>): string {
  // The offline baseline only records keyword hits.
  if (!Array.isArray(trace.steps)) return `  ${JSON.stringify(trace)}`;

  const lines: string[] = [];
  let totalMs = 0;
  for (const s of trace.steps as (TurnStep | ToolStep)[]) {
    if ("tool" in s) {
      lines.push(`    ${s.tool} ${describeInput(s)} -> ${describeResult(s.result)}`);
      continue;
    }
    totalMs += s.ms ?? 0;
    lines.push(
      `  turn ${s.turn + 1}: ${s.stop_reason}, ${seconds(s.ms)}, ${s.input_tokens ?? "?"} in / ${s.output_tokens ?? "?"} out tokens (${s.served_by})`,
    );
  }
  const usage = trace.usage as { input_tokens: number; output_tokens: number } | undefined;
  const total = usage ? `, ${usage.input_tokens} in / ${usage.output_tokens} out tokens` : "";
  lines.push(`  stop: ${trace.stop}, ${seconds(totalMs)}${total}`);
  if (trace.needs_human_reason) lines.push(`  for a person: ${trace.needs_human_reason}`);
  return lines.join("\n");
}

function describeInput(s: ToolStep): string {
  if (s.tool !== "submit_proposal") return JSON.stringify(s.input);
  const p = s.input as { category?: string; needs_human?: boolean; cited_kb_ids?: string[] };
  return `category=${p.category} needs_human=${p.needs_human} cites=[${(p.cited_kb_ids ?? []).join(", ")}]`;
}

function describeResult(result: unknown): string {
  if (Array.isArray(result)) return result.length ? result.join(", ") : "nothing found";
  if (result && typeof result === "object" && "error" in result) {
    const error = String(result.error).replace(/\s+/g, " ");
    return `error back to the model: ${error.length > 120 ? `${error.slice(0, 120)}...` : error}`;
  }
  return String(result ?? "-");
}

const seconds = (ms?: number) => (ms === undefined ? "?" : `${(ms / 1000).toFixed(1)} s`);
