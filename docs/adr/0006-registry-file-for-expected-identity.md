---
status: accepted
---

# A registry file records Expected identity; a Profile's config directory is `<state dir>/<alias>`

ADR-0005 deferred a registry file because nothing yet needed to store more about a Profile than
its bare Alias, and named the moment that would force one: CONTEXT.md's **Expected identity**,
which Drift detection needs and a directory name alone cannot carry. `ccp login` is that moment —
recording who a Profile turned out to be, distinct from asking `claude` who it is *right now*, is
the whole point of the command. This amends ADR-0005 forward rather than patching it, as that ADR
itself instructed.

**The registry is a JSON file, `registry.json`, under the tool's state directory (`~/.ccacct`,
per issue #3).** Its shape:

```json
{
  "profiles": {
    "work": { "expectedIdentity": { "email": "dev@example.com", "orgName": "Acme Corp" } },
    "personal": { "expectedIdentity": null }
  }
}
```

Only Expected identity lives here for now — issue #3's registry needs (creation, uniqueness,
listing) are out of scope for this decision and may extend this shape.

**A Profile's config directory is `<state dir>/<alias>`**, not a value stored in the registry.
This extends ADR-0005's "Alias is the config directory's basename" the other direction: given the
Alias, the directory is computed, not looked up. `ccp login <alias>` therefore works whether or
not the alias has been formally registered yet — the directory is created the moment `claude`
itself first writes to it (ADR-0005's own observation about `auth status` applies equally to
`auth login`).

Because the directory is computed by string-joining `stateDir` and the Alias rather than looked
up, an Alias containing a path separator or a bare `.`/`..` segment could otherwise resolve
*outside* `stateDir` entirely — silently pointing a "Profile" at an arbitrary directory on disk,
which breaks "scoped to that Profile only" outright. `configDirFor` therefore rejects such an
Alias before any command derives a directory from it.

## Considered Options

- **Store `configDir` in the registry alongside Expected identity.** Rejected: it would let a
  Profile's directory and its Alias drift apart, which is exactly the ambiguity ADR-0005 avoided
  by deriving Alias from the directory's basename in the first place. One canonical direction
  (Alias → path by convention, path → Alias by basename) keeps both commands agreeing without a
  lookup that could go stale.
- **Skip persistence and re-derive "expected" from a live `claude auth status` query each time.**
  Rejected outright: CONTEXT.md's Drift is defined as expected identity diverging from observed
  identity. If expected were itself always a fresh live query, the two could never differ, and
  Drift detection — the reason Expected identity exists as a concept — would be unimplementable.

## Consequences

- `ccp login <alias>` never touches credential material itself (ADR-0001): it shells out to
  `claude auth login` with `CLAUDE_CONFIG_DIR` set to the Profile's directory, exactly as
  `authStatus` already does for `auth status --json`, then asks that same `authStatus` what the
  flow produced before writing anything to the registry.
- A missing registry file reads as an empty registry (nothing has recorded an expected identity
  yet), not an error — only a file that exists and is malformed is treated as actionable-error
  territory, matching issue #3's "missing or malformed registry" language even though `ccp ls`
  itself is still unbuilt.
- Recording one alias's expected identity reads, mutates only that one key, and rewrites the whole
  file — every other alias's entry passes through untouched. This is what makes "logging in one
  Profile leaves every other Profile's identity intact" a property of the storage layer, testable
  without faking anything but the unautomatable part (the real interactive login flow itself).
- Issue #3's `ccp add`/`ccp ls` will read and extend this same file. Aliases created by `ccp add`
  before ever logging in should be expected to round-trip through `readRegistry` with
  `expectedIdentity: null` — this decision's shape already accommodates that.
