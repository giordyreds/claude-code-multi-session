---
status: accepted
---

# Identity is one type, narrowed at the port

[Issue #47](https://github.com/giordyreds/claude-code-multi-session/issues/47) unified the
(Account, Organization) pair into one `Identity` type in `identity.ts`. This ADR closes the half
of the problem #47 left open: `AuthStatus`, the shape `claude-port.ts` hands every other module,
still made the impossible state representable —

```ts
export interface AuthStatus { loggedIn: boolean; email?: string; orgName?: string }
```

`{ loggedIn: true }` with no `email` was constructible, so nothing stopped every caller from
writing its own guard against it. Five did: `cli.ts:378`, `cli.ts:566`, `cli.ts:616`, the deleted
`drift.ts:12`, and `doctor.ts:397`, each hand-rolling `status.email === undefined ||
status.orgName === undefined`. CONTEXT.md's **Identity** entry already states the rule as a
domain fact — an Identity has both halves or it is not an Identity — and its **Observed
identity** entry spells out the consequence: a Profile logged in without naming both halves "has
nothing that can drift, and nothing that can be reconciled." `AuthStatus`'s type contradicted the
glossary it was supposed to model.

**`AuthStatus` is now narrowed once, inside `claude-port.ts`'s `toAuthStatus`:**

```ts
export type AuthStatus = { loggedIn: false } | { loggedIn: true; identity: Identity | null };
```

`identity: null` means exactly what CONTEXT.md's Observed identity entry describes: `claude`
reported a login without naming both an Account and an Organization. Every module past this
boundary narrows `status.loggedIn` and then, if true, `status.identity`, using the compiler
rather than a convention to enforce it. No module outside `claude-port.ts` reads `.email` or
`.orgName` off a status — they read `.identity`, already a whole `Identity` or nothing.

**`identity.ts` gains the verdict `AuthStatus`'s narrowing feeds into:**

```ts
export type DriftVerdict = { comparable: false } | { comparable: true; drifted: boolean };

export function compareToExpected(expected: Identity | null, observed: Identity | null): DriftVerdict
```

This is the sole decision point for Drift (CONTEXT.md). `src/drift.ts` — whose `isDrifted`
returned a bare `boolean`, collapsing "nothing to compare" and "compared and equal" into the same
`false` — is deleted; `test/drift.test.ts`'s cases now live in `test/identity.test.ts` as
`compareToExpected` tests.

## Why a three-state verdict, not a boolean

`cli.ts`'s `reportDriftAndUpdateRegistry` (called by `ccp use`) must **not** touch a Profile's
stored `drifted` flag when there's nothing to compare — its doc comment explains why: "there is
nothing observed to prove it's still drifted, or to prove it isn't." A logged-out Profile keeps
whatever Drift state was already recorded, and so does a Profile `claude` reports as logged in
with `identity: null`.

A boolean-returning comparison can't distinguish those two facts from its caller's point of view:
`false` would have to mean both "confirmed not drifted, go ahead and record that" and "couldn't
even check, don't touch the record" — and a caller that treats the second like the first silently
clears a recorded drift flag the moment a Profile logs out. `DriftVerdict`'s `comparable: false`
branch exists so that mistake is a type the caller has to actively discard (`if
(!verdict.comparable) return;`), not a value it can accidentally read past. `test/cli.test.ts`
covers both paths that reach this guard explicitly: a logged-out Profile, and a Profile `claude`
reports as logged in with `identity: null` — two distinct branches through
`reportDriftAndUpdateRegistry`, not one.

## Relationship to ADR-0005

ADR-0005 decided **one port** for every `claude` invocation, and that success is judged by output
shape rather than exit code. Its Consequences promised "any future change to `auth status
--json`'s shape is a one-file fix" — true of the wire format, but four doc comments in this
codebase (now corrected) cited ADR-0005 itself as the source of `AuthStatus`'s optional-field
*type*, which that ADR never decided. This ADR decides that part: not which port to call or how to
judge its exit code, but how the port's return type models the one case Claude Code's real output
never actually produces but its documented shape doesn't rule out.

## Considered Options

- **Throw inside the port when a logged-in report is missing a half.** The cleanest type of the
  options considered — `AuthStatus`'s logged-in branch could carry a plain `Identity`, no `null`
  needed. Rejected: it would fail the whole of `ccp ls` for one odd Profile among many, where
  today `formatLiveIdentity` degrades to `(unknown)` and keeps listing the rest. A single
  unparseable Profile becoming a hard error for every other row is a worse failure mode than the
  narrow type this ADR chose instead.
- **Leave `AuthStatus` alone and keep the five hand-rolled guards.** Rejected: the guards already
  disagreed in shape (some checked `email === undefined || orgName === undefined`, others reached
  for `drift.ts`'s `isDrifted`), and nothing stopped a sixth call site from reintroducing the same
  check a seventh way. A type error at the boundary is enforced once, everywhere, permanently.
- **Give `DriftVerdict`'s `comparable: true` branch the compared `Identity` values, not just
  `drifted`.** Considered while wiring `reportDriftAndUpdateRegistry`, which needs the actual
  Expected/Observed pair to print the Drift warning. Rejected in favor of matching the issue's
  specified shape exactly and letting call sites narrow `expected`/`observed` themselves ahead of
  calling `compareToExpected` — the verdict answers "should I act," not "here's what to print."

## Consequences

- `ccp ls` renders a single `(unknown)` for a logged-in-but-incomplete Profile, instead of the
  previous `(unknown) ((unknown))` (`formatLiveIdentity` fed two placeholder strings into
  `formatIdentity`'s "email (orgName)" shape). Cosmetic, but user-visible: this is the one
  accepted behaviour change.
- The wire format is untouched. `claude auth status --json`'s shape hasn't moved, so
  `test/shell-integration.test.ts`'s six fixtures don't either — this ADR narrows a type on this
  side of the port, not the JSON on the other side of it.
- `identity.ts` stays a leaf module; `compareToExpected` takes and returns only `identity.ts`'s
  own types, so it still imports nothing from the rest of `src/`.
- A future sixth call site that needs to know whether a Profile has drifted has one function to
  call, not a fourth way to spell the same guard.
