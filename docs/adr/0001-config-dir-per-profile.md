---
status: accepted
---

# One config directory per Profile carries identity

Each Profile is a separate Claude Code configuration directory, and a shell adopts a
Profile by being pointed at that directory. We verified empirically that two directories
hold two different live identities concurrently, with no interference: `auth status` in
each reported its own account and organization, and the pre-existing default install was
unaffected. Identity selection lives in the directory's own state file; the secret material
stays in a single OS keychain entry that evidently keys multiple accounts internally, so
**this project never reads, writes, or stores credentials** — it delegates every login to
Claude Code itself.

## Considered Options

- **Long-lived tokens injected per shell** (`setup-token` + an environment variable).
  Guaranteed concurrent, but inherits CI semantics — no interactive refresh, annual expiry,
  possibly different entitlement treatment — and would force us to store credentials
  ourselves. Kept as the documented fallback if directory isolation ever breaks.
- **Swapping the keychain entry on each switch.** Rejected: it makes identity a
  machine-wide property, which defeats concurrent shells outright and races between them.

## Consequences

- The isolation mechanism is reverse-engineered from probes, not documented by Anthropic.
  It may change without warning, so the credential-store assumption stays behind a single
  module boundary.
- Claude Code runs a per-configuration daemon, so N Profiles likely means N daemons.
  Removing a Profile should attempt to clean its daemon up.
- Reported login state reflects *stored* credentials, not server-validated ones. A Profile
  can report logged-in with an unusable token; we surface stored state honestly rather than
  spending an API call to prove liveness.
