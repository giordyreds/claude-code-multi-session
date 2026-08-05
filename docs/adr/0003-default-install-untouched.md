---
status: accepted
---

# The default install is never migrated

The pre-existing Claude Code configuration stays exactly as it is: unbound shells keep
working, its history is never moved, and it is the source of the shared Rig. Managed
Profiles are always newly created directories. This buys a working tool without ever
putting an existing install's project history at risk.

## Considered Options

- **Adopt the existing install as a Profile.** Rejected for v1. It requires moving a large
  history directory and mutating a working install, and afterwards an unbound invocation —
  muscle memory, an IDE extension, a scheduled job — would start with *no identity at all*.
  That is a real regression traded for a purely aesthetic gain (symmetry), so it stays
  deferred until asymmetry is proven annoying in daily use.
- **Point a Profile at the existing directory.** Impossible, and the reason is worth
  recording so nobody retries it: the default install and an explicitly-bound directory
  read *different* state files. Binding to the existing directory reports logged-out and
  starts a fresh state file beside the real one — verified by probe.
- **Symlink the two state files together.** Rejected as actively dangerous: config writers
  typically write-then-rename, which replaces a symlink with a regular file and silently
  forks state into two diverging copies.

## Consequences

- The default install is both an identity and the Rig source. Editing its settings edits
  every Profile's base — intended, since one authored file beats two, and a base that
  nobody uses would drift on day one.
- Listings must represent an unmanaged default row honestly, and prompts must mark unbound
  shells explicitly rather than showing nothing: under this decision, unbound means the
  higher-entitlement account, which is the expensive one to use by accident.
- The desktop app and IDE extensions read the default install, so they always use its
  account regardless of what any shell is bound to. A genuine limitation, not a deferral.
