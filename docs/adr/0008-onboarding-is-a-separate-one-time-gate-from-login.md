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
  `hasCompletedOnboarding`. **Rejected, confirmed by probe** — see the amendment below. Tracked as
  issue #27.
- **Pre-seed `hasCompletedOnboarding`** (and related fields) into a freshly created Profile's
  `.claude.json`, copied from the Default install's `~/.claude.json`. **Accepted, confirmed by
  probe** — see the amendment below. This is ADR-0005's own rejected option — reading Claude
  Code's undocumented state file directly — accepted here, for the first time, in the narrow case
  of *writing* two specific fields for a UX nicety rather than identity correctness. Tracked as
  issue #27.
- **Document it as a one-time manual step.** Superseded for every Profile created after this
  amendment — see below — but stays the accurate description of a Profile created before it, and
  the honest fallback whenever pre-seeding finds nothing to copy.

## Consequences

- `ccp login`'s own success report (`loggedIn: true`) is honest but incomplete as a predictor of
  what the interactive app will do next — a gap worth remembering before trusting `ccp login`
  succeeding as proof a Profile is friction-free to actually use.
- A Profile created before this amendment shipped still pays the one-time manual-step cost
  described above, unchanged: the wizard is a one-time gate per Profile, so there is nothing to
  retrofit — a Profile that already clicked through it once has nothing left to fix.

## Amendment 1: resolved by probe — pre-seed, not auto-complete

Both deferred options were unverified when this ADR was first accepted. Probed directly (2026-08-07):

- **Auto-complete via `claude -p`: fails.** A fresh, logged-in `configDir` still shows the
  onboarding wizard on its first interactive `claude` launch even after a non-interactive
  `claude -p "hi" --model claude-haiku-4-5-20251001` call already succeeded against it.
  `hasCompletedOnboarding` never appears in `.claude.json` until the wizard is actually completed
  interactively — a headless call plainly doesn't trip whatever sets it. This option is dead; no
  cheaper model or different prompt changes what's being checked.
- **Pre-seed: works, and survives a stale version.** Completing the wizard for real, diffed
  before/after, isolates the mechanism to exactly two fields: `hasCompletedOnboarding: true` and
  `lastOnboardingVersion: "<version>"` — confirming this ADR's original account, not contradicting
  it. Copying only those two fields from a real Default install's `~/.claude.json` — including a
  `lastOnboardingVersion` **one release behind** the CLI version actually running — into a
  never-launched Profile's `.claude.json`, written after `claude auth login` creates that file but
  before the first interactive launch, fully skips the wizard. Claude Code isn't strictly comparing
  the seeded version against its own build, at least across a one-version gap.
- What this doesn't settle: a *shape* change (Claude Code renaming or restructuring these fields
  in some future release) rather than a *version* mismatch. No probe rules that out — only a
  design choice can contain it, which is why the implementation (`src/onboarding.ts`) resolves any
  read it doesn't cleanly recognize to "seed nothing" rather than guessing, the same fallback this
  ADR always had.

Implemented in `src/onboarding.ts`'s `seedOnboardingState`, called from `ccp login` right after a
successful `ClaudePort.login`. Best-effort in both directions — a source that isn't there, isn't
onboarded itself, or doesn't parse, and a destination that doesn't exist yet or already completed
onboarding, all silently do nothing; only a genuine write failure surfaces, as a warning that never
fails `ccp login` itself. A Profile whose pre-seed found nothing to copy — most commonly because
the Default install itself has never completed onboarding interactively — still falls back to this
ADR's original one-time manual step, unchanged.
