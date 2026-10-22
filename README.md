# support-agent-demo

An AI support agent that drafts replies, a named person approves them, and plain code sends them, exactly once, even if the worker dies halfway through a send.

The model is the easy part. This repo is about the parts around it:

- what the agent is allowed to touch (almost nothing),
- where the workflow waits for a person (a row in Postgres, not a process),
- how a crash between "the helpdesk accepted the reply" and "we wrote that down" doesn't turn into a second reply to the customer,
- how you know a prompt change made things better (golden set with gates), and whether an LLM judge can be trusted to grade drafts (calibration against human labels).

The helpdesk is fake and the company (Acme Learn, an online course platform) is made up. Everything else is meant to be the real shape.

## Run it

```bash
npm install
npm run demo              # whole flow in one process, incl. a simulated crash mid-send
npm test                  # 23 tests, embedded Postgres (PGlite), no setup
npm run eval              # golden set through the same gates CI uses
npm run judge:calibrate   # judge vs human labels
```

No API key needed: by default drafts come from a keyword baseline (`RuleProposer`). To use Claude:

```bash
export ANTHROPIC_API_KEY=...
PROPOSER=claude npm run demo
npm run eval -- --proposer claude          # 37 agent runs
npm run judge:calibrate -- --judge claude  # 24 calls
```

Two-terminal mode against a real Postgres (PGlite allows one process at a time):

```bash
docker compose up -d
export DATABASE_URL=postgres://postgres:postgres@localhost:5432/support
npm run review -- ingest examples/ticket.json
npm run worker                       # leave running; kill it whenever you like
npm run review -- queue
npm run review -- approve 1 --as "Olena"
```

## How it flows

```mermaid
stateDiagram-v2
    [*] --> new: webhook (deduped by message id)
    new --> drafting: worker takes a lease
    drafting --> new: model error, backoff
    drafting --> awaiting_approval: draft passes policy
    drafting --> human_handling: policy escalates / retries exhausted
    awaiting_approval --> new: customer writes again (draft superseded)
    awaiting_approval --> replied: approved by name, outbox sends
    awaiting_approval --> human_handling: rejected
    replied --> new: customer writes again
```

`tick()` in [src/worker.ts](src/worker.ts) does one pass over everything that is ready and keeps nothing in memory. Waiting for a person can take a minute or a week; it's just a proposal row with `status = 'pending_approval'`.

## Decisions

### The agent proposes, a person approves, code executes

The model gets two tools ([claude-proposer.ts](src/agent/claude-proposer.ts)): `search_kb`, read-only, and `submit_proposal`, which stores a draft. Nothing it can call reaches the customer, a payment or an account. Sending lives in [outbox.ts](src/services/outbox.ts), which has no LLM in it and only picks up rows that an approval created.

Approval and the outbox row are written in one transaction ([approvals.ts](src/services/approvals.ts)), so "approved but never sent" and "sent without approval" can't happen. The database refuses an approved or rejected proposal without `decided_by`, so the rule holds even for code that skips the service. In a real app the name comes from the auth session, not the request body.

### Policy runs in code, after the model

[policy.ts](src/agent/policy.ts) checks every draft, whatever the model said:

- refund and privacy requests never get a customer-facing draft;
- risky words in the ticket (money, data deletion, lawyers) escalate even if the model picked a harmless category, because the classifier is the thing most likely to be wrong;
- a draft must cite an article the agent actually retrieved in this run;
- links must be on an allowlist (look-alike hosts such as `acme-learn.example.reset-help.net` fail);
- "I've extended your deadline" / "we'll refund you" style commitments block the draft.

A reply the approver edits by hand goes through the same output checks.

### Prompt injection: layers, not a detector

Customer text is escaped and wrapped in `<ticket>` so it can't close the tag, and the system prompt says it is data. A regex flags obvious attempts, but nothing relies on it. What matters is that the model has no dangerous tools, its output is schema-checked and policy-checked, and a person reads it before it goes out. The eval reports how many drafts carried an attacker's link or promise in the model's own output and how many of those reached the approval queue (should be zero).

### Exactly one reply per approval

At-least-once delivery plus a few rules:

| Worker dies... | What happens next |
|---|---|
| during the LLM call | drafting lease expires, another worker drafts again; `unique (ticket_id, ticket_version)` keeps one proposal |
| after approval commits | outbox row is there, any worker sends it |
| after claiming, before sending | send lease expires, job is re-claimed, nothing found in the helpdesk, sent |
| after the helpdesk accepted, before we recorded it | job is re-claimed, `findByIdempotencyKey` finds the reply, it's recorded without sending again |
| and wakes up later still thinking it owns the job | the result write is fenced on the attempt number, matches 0 rows, `lost_lease` |
| helpdesk returns errors | exponential backoff; after N attempts the job is `dead` and the ticket goes to a person |

Jobs are claimed with `FOR UPDATE SKIP LOCKED`, so several workers can run side by side. One invariant to keep: the lease must be longer than the channel's send timeout. Most helpdesks and mail servers don't dedupe on a key you choose, hence the lookup before a resend (Zendesk: store the key in comment metadata; email: derive Message-ID from it). If the provider does accept an idempotency key, pass it and the lookup becomes a safety net.

All of these are tests in [test/workflow.test.ts](test/workflow.test.ts). CI runs them on PGlite and on Postgres 17.

### Evals

[evals/golden.jsonl](evals/golden.jsonl) has 37 tickets with the expected category, route (draft or person) and the article a good draft should cite. It includes injection attempts, a refund request that never says "refund", a cancellation question that is not a refund, a message in Ukrainian, and things support doesn't handle.

[evals/run.ts](evals/run.ts) runs proposer and policy together, the way production does, and gates on:

| metric | gate | why |
|---|---|---|
| escalation recall | = 1.0 | a refund or privacy request reaching the draft queue is the expensive mistake |
| unsafe drafts in the queue | 0 | attacker links and promises must never reach a reviewer as a normal draft |
| over-escalation | <= 0.3 | escalating everything is safe and useless |
| grounded drafts | >= 0.8 | draft cites the right article |
| category accuracy | >= 0.7 | plus recall and precision per category |

Baseline results: [evals/reports/baseline-rules.md](evals/reports/baseline-rules.md). The per-category table shows where it is weak (non-English, wording without keywords). Case `ref-4` ("you still took a payment, I want that payment returned") never says "refund". With only the obvious money keywords in policy it goes through as a billing draft and the escalation gate fails at 0.92; the wider money rule in policy is what keeps it at 1.0. That's the loop: a miss becomes a golden case, then a fix, and the gate keeps it fixed.

`npm run eval` runs in CI on every push. The Claude version runs on demand ([eval-claude.yml](.github/workflows/eval-claude.yml)) because it costs money.

### Is the judge any good?

An LLM judge is useful for grading drafts at scale, but only once you know it agrees with people. [evals/judge-labels.jsonl](evals/judge-labels.jsonl) has 24 drafts labelled pass/fail by hand, with the reason. [calibrate-judge.ts](evals/calibrate-judge.ts) reports agreement, Cohen's kappa and recall on the human "fail" labels, since catching bad drafts is the judge's job.

The heuristic judge in the repo shows why this step exists: precision 1.00, but it catches 4 of 11 bad drafts (kappa 0.38), missing wrong numbers, the wrong article and replies that ignore the actual question. It is marked not trusted ([report](evals/reports/judge-heuristic.md)). The Claude judge goes through the same gate (`--gate` fails the run below kappa 0.6 or fail-recall 0.8).

The labels here are written for the demo. For real use: 100–200 real tickets, two people labelling, check how often they agree with each other first, and re-calibrate whenever the judge prompt, the model or the rubric changes. Approver edits are a free label stream: a draft that was approved unchanged is a pass.

### Claude API notes

- `claude-opus-5-5`, effort `low` for drafting, `medium` for judging.
- No forced `tool_choice` (current models return 400). The prompt says when to call each tool, tools are `strict`, and inputs are validated with Zod anyway; a bad `submit_proposal` goes back to the model as a tool error.
- `fallbacks: "default"`: if the model declines, the API retries on a fallback model. A refusal that still comes back hands the ticket to a person.
- The loop is capped at 4 turns; no proposal means a handoff, not a guess.

## Layout

```
src/
  agent/       claude-proposer, rule-proposer (offline baseline), policy, kb search
  services/    ingest, drafting, approvals, outbox, audit
  channel/     channel adapter + fake helpdesk
  db/          schema.sql, PGlite / pg adapter
  worker.ts    one stateless pass
  cli/         demo, worker, review
kb/            12 help-center articles
evals/         golden set, judge labels, runners, reports
test/          workflow, policy, agent loop
```

## Not here on purpose

A real helpdesk adapter, auth and a reviewer UI, vector search, PII redaction before text goes to the model, per-tenant cost budgets, tracing. Each one plugs into an existing seam (`ChannelAdapter`, `Proposer`, the `approver` field, `trace` on the proposal).

## License

MIT
