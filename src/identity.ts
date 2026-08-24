/**
 * The (Account, Organization) pair — see CONTEXT.md's **Identity**. Never used bare: every value
 * of this shape is either an Expected identity or an Observed identity, and which one is the
 * authority is the whole difference between them (CONTEXT.md's **Expected identity**, **Observed
 * identity**). That provenance rides on the field and variable names at each call site — never on
 * this type, which is deliberately the same shape for both.
 *
 * A leaf module: imports nothing from the rest of `src/`, so every module that touches Identity —
 * `registry.ts`, `doctor.ts`, `claude-port.ts`, `cli.ts` — can depend on it with no risk of a
 * cycle.
 */
export interface Identity {
  email: string;
  orgName: string;
}

/**
 * Renders an Identity the way every command that prints one needs it — `ccp whoami`/`ccp login`'s
 * report, `ccp ls`'s rows, `ccp use`'s Drift warning, `ccp reconcile`'s confirmation, and `ccp
 * doctor`'s identity-isolation Check — so there is exactly one place deciding what "email
 * (orgName)" looks like, not one copy per module that happened to need it.
 */
export function formatIdentity(identity: Identity): string {
  return `${identity.email} (${identity.orgName})`;
}

/** A stable key for grouping and comparing Identity values — collapses both fields into one
 * comparable string, used by {@link sameIdentity} and by `doctor.ts`'s identity-isolation Check
 * to group Profiles by their observed Identity. */
export function identityKey(identity: Identity): string {
  return JSON.stringify([identity.email, identity.orgName]);
}

/** Whether two Identity values name the same (Account, Organization) pair. Implemented via
 * {@link identityKey} so there is exactly one comparison rule. */
export function sameIdentity(a: Identity, b: Identity): boolean {
  return identityKey(a) === identityKey(b);
}

/**
 * The result of comparing a Profile's Expected identity against its currently observed one — see
 * CONTEXT.md's Drift. `comparable: false` covers every reason the comparison can't be made at
 * all: no Expected identity was ever recorded, or there is no Observed identity right now (a
 * Profile that's logged out, or one `claude` reports as logged in without naming both an Account
 * and an Organization — CONTEXT.md's Observed identity). A three-state verdict rather than a
 * boolean exists for exactly one reason: collapsing "not comparable" into `drifted: false` would
 * read as "confirmed not drifted" to a caller like `cli.ts`'s `reportDriftAndUpdateRegistry`,
 * which must leave a Profile's recorded Drift state untouched rather than silently clearing it
 * when there's nothing observed to prove it one way or the other (issue #48).
 */
export type DriftVerdict = { comparable: false } | { comparable: true; drifted: boolean };

/**
 * Compares a Profile's Expected identity against its Observed identity (both possibly absent —
 * see {@link DriftVerdict}) and reports whether the comparison could even be made, and if so,
 * whether the two disagree. The sole decision point for Drift (CONTEXT.md): every caller that
 * used to hand-roll "do I have enough to compare, and if so do they match" now narrows this one
 * verdict instead.
 */
export function compareToExpected(expected: Identity | null, observed: Identity | null): DriftVerdict {
  if (!expected || !observed) return { comparable: false };
  return { comparable: true, drifted: !sameIdentity(expected, observed) };
}
