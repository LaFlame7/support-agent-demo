import { draftNext, type DraftDeps, type DraftOutcome } from "./services/drafting.js";
import { sendNext, type SendDeps, type SendOutcome } from "./services/outbox.js";

export type WorkerDeps = DraftDeps & SendDeps;

/**
 * One pass over everything that is ready. Holds no state between passes:
 * the wait for a human decision is a row in Postgres, not a pending promise,
 * so it can last minutes or days and survive any number of restarts.
 */
export async function tick(deps: WorkerDeps) {
  const drafted: DraftOutcome[] = [];
  const sent: SendOutcome[] = [];
  for (let r = await draftNext(deps); r; r = await draftNext(deps)) drafted.push(r);
  for (let r = await sendNext(deps); r; r = await sendNext(deps)) sent.push(r);
  return { drafted, sent };
}
