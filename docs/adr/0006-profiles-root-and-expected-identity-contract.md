---
status: accepted
---

# `ccp use` resolves Aliases under `~/.ccacct`, and reads Expected identity from a file this ADR defines

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
