---
status: superseded
---

# `ccp use` resolves Aliases under `~/.ccacct`, and reads Expected identity from a file this ADR defines

> **Superseded before merge.** #3 and #4 landed while this branch was in flight, with a registry
> shape this ADR didn't anticipate (stored `configDir`, not a computed one — see ADR-0006's own
> "Superseded, in part" section, filed for the identical situation on #4's branch). See the
> amendment at the bottom for what `ccp use` actually does now. The numbering collision — this
> file and ADR-0006 were both independently filed as "0006" by branches that each thought the
> other hadn't landed — is resolved by renumbering this one to 0007, keeping 0006 for the one
> that matches the ADR-0005 lineage it amends.

Issue #5 (`ccp use <alias>`) is blocked by #4 (`ccp login`, which is blocked by #3, the Profile
registry) for a concrete reason: knowing whether an Alias is *known*, and what identity it is
*expected* to resolve to, both require state that #3 and #4 were going to own. Neither had
landed on `development` when #5 was implemented — both blocker branches exist but hold no
commits beyond `development`'s tip. Binding cannot honestly be deferred behind that, so this
ADR fixes two provisional contracts narrowly, scoped to exactly what `ccp use` needs, so #3 and
#4 land against a real consumer instead of a guess.

**Alias resolution: a Profile's directory is `~/.ccacct/<alias>`, with no registry lookup.**
This is the natural inverse of ADR-0005 (Alias is the config directory's basename) and matches
the state directory ticket #3 already commits to. "Unknown Alias" is decided by directory
existence alone — consistent with ADR-0005's own observation that a not-yet-created Alias is
indistinguishable from an empty, logged-out Profile. The root is overridable via the
`CCACCT_HOME` environment variable so tests never touch a real `$HOME`.

**Expected identity: a per-Profile file, `<configDir>/.ccp/expected-identity.json`.** Shape:
`{ "email"?: string, "orgName"?: string }`. Living inside the Profile's own config directory —
not a central registry — follows ADR-0001's "identity lives in the directory" precedent, and
keeps `ccp use` from having to know anything about #3's eventual registry format. `ccp use`
only *reads* this file, treating a missing or malformed one as "no expectation recorded" (never
a hard failure — CONTEXT.md's Expected identity is "an expectation, never an authority"). #4
owns *writing* it, once `ccp login` exists; this ADR fixes the file's location and shape so #4
has a target to write to rather than inventing its own.

## Considered Options

- **Wait for #3 and #4 before starting #5.** Correct in an ideal sequencing, but the blocker
  branches carry no work, and Binding is CONTEXT.md's core feature. Rejected for now; revisit if
  #3/#4 land with an incompatible registry shape (see Consequences).
- **A central registry file for expected identity (`~/.ccacct/registry.json`), owned by #5.**
  Rejected: recording expected identity is explicitly #4's deliverable, and a central registry
  is explicitly #3's. Building either here duplicates work two other tickets already own and
  risks a conflicting shape landing on three branches at once.
- **Skip mismatch ("Drift") reporting entirely until #4 exists.** Rejected: the acceptance
  criteria for #5 require it, and the file-based contract above costs one file format decision,
  not a registry.

## Consequences

- If #3 lands with Profile directories somewhere other than `~/.ccacct/<alias>` (e.g. arbitrary
  user-chosen paths recorded in a registry), `resolveProfileDir` in `src/profile.ts` becomes
  wrong and must be replaced with a registry lookup. That is a one-file fix, isolated the same
  way ADR-0005 isolated the `claude` invocation.
- If #4 lands writing expected identity somewhere else, `src/expected-identity.ts`'s read path
  moves to match. Nothing outside that file needs to change.
- Until #4 exists, no Alias has a recorded expected identity, so `ccp use` can never actually
  observe Drift in practice — only the "logged out" half of the "logged-out or mismatched"
  acceptance criterion is reachable outside tests. The Drift path is exercised in `ccp use`'s
  tests by writing the expected-identity file directly, standing in for `ccp login`.
- `CCACCT_HOME` is a new environment variable with no other purpose yet. If #3 introduces its
  own override mechanism, reconcile rather than keep two.

## Amended, on merge, by #3 and #4 landing for real

Both provisional contracts above are gone; `src/profile.ts` and `src/expected-identity.ts` are
deleted. `ccp use <alias>` now does exactly what this ADR's own Consequences predicted:

- **Alias resolution is a registry lookup.** `ccp use` calls `loadRegistry(stateDir)` (from
  `src/registry.ts`, ADR-0006) and looks up `alias` there. "Unknown Alias" is now "no entry in
  the registry" rather than "no directory on disk" — the config directory `ccp use` binds to is
  the registry entry's own `configDir` field, never a freshly computed `<stateDir>/<alias>`.
  Unlike `ccp login`, `ccp use` does **not** fall back to `addProfile` for an unregistered alias:
  Binding never opens a browser or authenticates (this ticket's own acceptance criterion), and
  silently originating a Profile from `use` would give it a second, undocumented way to come into
  existence besides `ccp add`/`ccp login`.
- **Expected identity comes from the same registry entry**, `record.expectedIdentity` — no
  separate `.ccp/expected-identity.json` file, no separate read path to keep in sync. It's
  `ExpectedIdentity` from `src/registry.ts` now, whose `email`/`orgName` are non-optional once
  present (recording a partial identity was never possible — see `ccp login`'s own dedicated
  failure case for a status missing either field), so Drift comparison no longer needs this
  module's optional-field handling.
- **`CCACCT_HOME` is kept**, exactly as this ADR's Consequences asked ("reconcile rather than keep
  two") — but reconciled *into* `stateDir`, the one override mechanism #3/#4 actually built
  (`RunCliOptions.stateDir`, threaded through every subcommand). `CCACCT_HOME` is now read once,
  in `cli.ts`'s `defaultStateDir`, as that option's environment-variable fallback — the state
  directory a `CCACCT_HOME` override points at holds `registry.json` and every Profile's
  `profiles/<alias>` directory (ADR-0006), not a flat `<alias>` directory as originally specified
  here. This is what lets `test/shell-integration.test.ts` bind the real, built CLI against a temp
  directory without touching `$HOME`, exactly this ADR's original reason for introducing the
  variable.
- Drift is now reachable outside tests exactly as intended: `ccp login` records a real Expected
  identity, `ccp use` reads it back from the same registry, no stand-in file required.
