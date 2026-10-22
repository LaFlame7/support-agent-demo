# CLAUDE.md

Approval-gated support agent: LLM drafts, a named person approves, code sends exactly once. TypeScript, Node 22, ESM (import with `.js`), Postgres via PGlite or `DATABASE_URL`.

## Commands

```bash
npm test                 # vitest; set DATABASE_URL to run against real Postgres
npm run typecheck
npm run eval             # golden set + gates; exit 1 on regression
npm run judge:calibrate  # judge vs human labels
npm run demo
```

## Invariants (don't break these)

- The model never gets a tool with side effects. `search_kb` and `submit_proposal` only.
- `channel.send` is called from `src/services/outbox.ts` only, and only for outbox rows.
- Outbox rows are created only inside `approve()`, in the same transaction as the approval.
- Every state change that matters writes an `audit_log` row in the same transaction.
- Outbox result writes are fenced on `attempts`. Keep `leaseSeconds` > channel send timeout.
- Policy (`src/agent/policy.ts`) runs after every proposer, real or fake. Don't move checks into the prompt instead.
- Schema changes go in `src/db/schema.sql` and must stay idempotent (`if not exists`).

## Evals

- New failure seen in practice: add a case to `evals/golden.jsonl` first, then fix.
- Don't edit existing golden cases to make a run pass.
- Changing the judge prompt or model means re-running calibration before trusting its scores.
- Claude runs cost money: ask before running `--proposer claude` or `--judge claude`.
