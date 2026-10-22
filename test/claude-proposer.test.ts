import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { ClaudeProposer } from "../src/agent/claude-proposer.js";
import { kb } from "./helpers.js";

// Scripted stand-in for the Messages API: checks the agent loop, not the model.
function fakeClient(responses: object[]) {
  const requests: any[] = [];
  const client = {
    beta: {
      messages: {
        create: async (req: unknown) => {
          requests.push(structuredClone(req));
          const next = responses.shift();
          if (!next) throw new Error("no more scripted responses");
          return { model: "claude-opus-5-5", usage: { input_tokens: 10, output_tokens: 5 }, ...next };
        },
      },
    },
  } as unknown as Anthropic;
  return { client, requests };
}

const toolUse = (id: string, name: string, input: object) => ({ type: "tool_use", id, name, input });
const ticket = { ticketId: 1, subject: "Forgot password", messages: [{ author: "customer" as const, body: "reset email never came" }] };
const proposal = {
  category: "account_access",
  reply: "Check spam, the reset link works for 60 minutes.",
  cited_kb_ids: ["acc-01"],
  needs_human: false,
  needs_human_reason: "",
};

describe("ClaudeProposer", () => {
  it("searches, then submits; records what it retrieved", async () => {
    const { client, requests } = fakeClient([
      { stop_reason: "tool_use", content: [toolUse("t1", "search_kb", { query: "password reset email" })] },
      { stop_reason: "tool_use", content: [toolUse("t2", "submit_proposal", proposal)] },
    ]);
    const out = await new ClaudeProposer(kb, client).propose(ticket);

    expect(out.proposal).toEqual(proposal);
    expect(out.retrievedKbIds).toContain("acc-01");
    expect(requests[0]).toMatchObject({ model: "claude-opus-5-5", fallbacks: "default" });
    expect(requests[0].tool_choice).toBeUndefined(); // forcing a tool 400s on current models
    const toolResult = requests[1].messages.at(-1).content[0];
    expect(toolResult).toMatchObject({ type: "tool_result", tool_use_id: "t1" });
    expect(JSON.parse(toolResult.content)[0].id).toBe("acc-01");
  });

  it("sends schema errors back to the model and accepts the corrected proposal", async () => {
    const { client, requests } = fakeClient([
      { stop_reason: "tool_use", content: [toolUse("t1", "submit_proposal", { ...proposal, category: "refunds" })] },
      { stop_reason: "tool_use", content: [toolUse("t2", "submit_proposal", proposal)] },
    ]);
    const out = await new ClaudeProposer(kb, client).propose(ticket);
    expect(requests[1].messages.at(-1).content[0]).toMatchObject({ tool_use_id: "t1", is_error: true });
    expect(out.proposal.category).toBe("account_access");
  });

  it("hands off to a person on refusal or when no proposal is submitted", async () => {
    for (const response of [
      { stop_reason: "refusal", content: [] },
      { stop_reason: "end_turn", content: [{ type: "text", text: "Here is my answer..." }] },
    ]) {
      const { client } = fakeClient([response]);
      const out = await new ClaudeProposer(kb, client).propose(ticket);
      expect(out.proposal.needs_human).toBe(true);
      expect(out.proposal.reply).toBe("");
    }
  });
});
