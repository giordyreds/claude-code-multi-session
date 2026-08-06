---
status: accepted
---

# A Profile's first interactive launch pays a one-time onboarding cost, separate from Login

`ccp login <alias>` fully authenticates a Profile — `claude auth status --json`, the one surface
ADR-0005 commits this project to, reports `loggedIn: true` immediately afterward. Verified by
probe: even so, the *first* time the interactive `claude` app is launched under that same
Profile's `CLAUDE_CONFIG_DIR`, it still runs a one-time onboarding wizard — a "Select login
method" screen that opens a browser and asks to authenticate again, exactly as if nothing had
happened.

The cause is a second, separate gate Claude Code keeps: onboarding completion, tracked as
`hasCompletedOnboarding` (plus `lastOnboardingVersion`) inside the Profile's own `.claude.json`.
`claude auth login`/`auth status` never touch this field; only completing the interactive wizard
once does. Completing it also (re)writes that Profile's own scoped macOS Keychain entry
(`Claude Code-credentials-<sha256(configDir)[:8]>`) — confirming, incidentally, that ADR-0001's
per-Profile isolation claim still holds on the current Claude Code version: each Profile really
does get its own keychain secret, keyed off its config directory, not a shared one.

This project's own concern — Login (CONTEXT.md) — and Claude Code's onboarding are therefore two
independent gates. `ccp` closes the first; the second stays closed until a human clicks through
the wizard once per Profile, in a real interactive terminal.

## Considered Options

- **Auto-complete onboarding inside `ccp login`**, by following the browser login with a
  non-interactive `claude -p <prompt>` scoped to the same `configDir`, hoping that alone flips
  `hasCompletedOnboarding`. Deferred, not rejected: unverified without a probe, and it would spend
  a trivial sliver of real API usage on every `ccp login`, automatically, to find out. Tracked as
  issue #27.
- **Pre-seed `hasCompletedOnboarding`** (and related fields) into a freshly created Profile's
  `.claude.json`, copied from the Default install's `~/.claude.json`. Rejected for now: this is
  ADR-0005's own rejected option — reading Claude Code's undocumented state file directly — this
  time to *write* it, for a UX nicety rather than identity correctness. Most exposed to a future
  Claude Code update silently changing that file's shape. Tracked as issue #27 alongside the
  option above, if the manual step below is ever felt as annoying in daily use.
- **Document it as a one-time manual step.** Accepted. Costs one extra `claude` launch per
  Profile, ever, in exchange for zero new coupling to undocumented internals beyond what
  ADR-0001/0005 already accept.

## Consequences

- The README's setup flow says so explicitly: run `claude` once, interactively, right after
  `ccp login <alias>`, before relying on that Profile from a script or a non-interactive shell.
- `ccp login`'s own success report (`loggedIn: true`) is honest but incomplete as a predictor of
  what the interactive app will do next — a gap worth remembering before trusting `ccp login`
  succeeding as proof a Profile is friction-free to actually use.
- Every Profile pays this cost exactly once. A second `claude` launch under the same
  `CLAUDE_CONFIG_DIR` — same shell or a new one — goes straight to a normal session.
