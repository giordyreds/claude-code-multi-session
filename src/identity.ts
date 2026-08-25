import type { AuthStatus } from "./claude-port.js";

/**
 * The (Account, Organization) pair — see CONTEXT.md's **Identity**. Never used bare: every value
 * of this shape is either an Expected identity or an Observed identity, and which one is the
 * authority is the whole difference between them (CONTEXT.md's **Expected identity**, **Observed
 * identity**). That provenance rides on the field and variable names at each call site — never on
 * this type, which is deliberately the same shape for both.
 *
 * This type itself stays a leaf: it imports nothing from the rest of `src/`, so every module that
 * touches Identity — `registry.ts`, `doctor.ts`, `claude-port.ts`, the `commands/*.ts` modules —
 * can depend on it with no risk of a cycle. {@link formatLiveIdentity} below does take a type-only
 * import of `claude-port.ts`'s `AuthStatus` (ADR-0015) — an ordinary downward dependency that
 * costs nothing at runtime, not a cycle: `claude-port.ts`'s own import of {@link Identity} is type
 * -only too, so nothing here actually depends on anything at module-evaluation time.
 */
export interface Identity {
  email: string;
  orgName: string;
}

/** Renders a bare status with no Identity behind it — either not logged in at all, or logged in
 * without `claude` naming both an Account and an Organization (permitted by {@link AuthStatus}'s
 * shape, ADR-0014, even though the real `claude auth status --json` never actually omits either
 * field). Shared by every render that needs this exact fallback wording: `ccp whoami`/`ccp
 * login`'s report (`commands/identity.ts`'s `formatIdentityReport`) and {@link formatLiveIdentity}
 * below. */
export const NOT_LOGGED_IN = "(not logged in)";

/** Renders a logged-in status whose identity came back `null` — see {@link NOT_LOGGED_IN}'s doc
 * comment for why that's a distinct state from "not logged in" at all. */
export const UNKNOWN = "(unknown)";

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
 * read as "confirmed not drifted" to a caller like `commands/shell.ts`'s `reportDriftAndUpdateRegistry`,
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

/**
 * Renders a live {@link AuthStatus} the way `ccp ls`'s Default-install row and the picker's rows
 * (ticket #9) both need it: an explicit `(not logged in)` rather than a blank, otherwise the
 * resolved Account/Organization pair, via {@link formatIdentity}. A logged-in status with
 * `identity: null` renders as a single `(unknown)` rather than `formatIdentity`'s "email (orgName)"
 * shape fed two placeholders — issue #48's accepted, user-visible behaviour change from the
 * previous `(unknown) ((unknown))`, since there is exactly one unknown here (no Observed identity
 * at all), not two separately unknown halves.
 *
 * Pure `AuthStatus` formatting with no `CliDeps` involved (ADR-0015) — an ordinary downward
 * dependency on {@link AuthStatus} from `claude-port.ts`, not a helper that owes its home to any
 * one `commands/*.ts` module. Used by `commands/identity.ts`'s `ccp ls` and `commands/shell.ts`'s
 * `pickAlias`.
 */
export function formatLiveIdentity(status: AuthStatus): string {
  if (!status.loggedIn) return NOT_LOGGED_IN;
  return status.identity ? formatIdentity(status.identity) : UNKNOWN;
}
