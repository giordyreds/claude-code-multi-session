/**
 * The (Account, Organization) pair — see CONTEXT.md's **Identity**. Never used bare: every value
 * of this shape is either an Expected identity or an Observed identity, and which one is the
 * authority is the whole difference between them (CONTEXT.md's **Expected identity**, **Observed
 * identity**). That provenance rides on the field and variable names at each call site — never on
 * this type, which is deliberately the same shape for both.
 *
 * A leaf module: imports nothing from the rest of `src/`, so every module that touches Identity —
 * `registry.ts`, `doctor.ts`, `drift.ts`, `cli.ts` — can depend on it with no risk of a cycle.
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
 * {@link identityKey} so there is exactly one comparison rule — not the field-by-field one
 * `drift.ts` used to carry separately, liable to drift out of sync with this one. */
export function sameIdentity(a: Identity, b: Identity): boolean {
  return identityKey(a) === identityKey(b);
}
