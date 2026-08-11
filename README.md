# claude-code-multi-session

`ccp` lets one machine hold several Claude Code identities at once, so separate shells
can run under separate accounts simultaneously — a work Team seat in one terminal, a
personal Pro subscription in another — without logging in and out to switch.

It never touches your existing `~/.claude` installation, never reads or stores
credentials, and shares your skills, plugins, hooks and commands across every identity
you add. macOS + zsh only; built as a personal tool, not published.

## Concepts

- **Profile** — a named, isolated Claude Code identity. Resolves to one (Account,
  Organization) pair.
- **Alias** — the short name you pick for a Profile (`work`, `personal`, `client-acme`).
- **Binding** — pointing the current shell at a Profile. A shell property, not a machine
  one — two shells can be bound to different Profiles at the same time.
- **Rig** — the identity-neutral configuration (skills, plugins, hooks, agents, commands)
  shared across every Profile.
- **Drift** — when a Profile's observed identity no longer matches what it was recorded
  as, typically because someone logged in directly while a shell was bound to it.
- **Setup** — the one-time act (`ccp setup`) of wiring the `ccp` shell function into a new
  shell and verifying the machine can run the tool at all. Distinct from *installing the
  package*, the separate, earlier act of putting the `ccp` command on `PATH` — that's npm's
  job, not `ccp`'s.
- **Contract** — a behaviour of Claude Code that `ccp` depends on but doesn't control (the
  shape of its identity output, the isolation `CLAUDE_CONFIG_DIR` provides, and so on).
  Anthropic never documented these, so a Contract is verified by observation, never assumed
  from a version number.
- **Check** — a runtime verification that a Contract still holds, reported by name
  alongside what it found (`ccp doctor` runs every Check). A Check reports; it never
  repairs — repair is `ccp sync`.

Full glossary in [`CONTEXT.md`](./CONTEXT.md); the design decisions behind them are
recorded as ADRs in [`docs/adr/`](./docs/adr/).

## Install

```sh
npm i -g github:giordyreds/claude-code-multi-session#semver:^1.0.0
ccp setup
```

Nothing is published to a package registry — the first line installs directly from this
GitHub repository. No path specific to your machine appears anywhere in it, and it never
goes stale: it resolves against release tags (see [Releases](#releases) below), not a
branch, so a colleague can paste it verbatim next year and still get the newest compatible
release.

The second line is **Setup**. It adds the `ccp` shell function to the interactive startup
file your shell actually reads — `$ZDOTDIR/.zshrc` if you use a managed dotfile setup,
`~/.zshrc` otherwise — by evaluating what `ccp shell-init` prints, rather than `source`-ing
`shell/ccp.sh` by an absolute path. An absolute path, under a Node version manager, is
scoped per Node version and can silently vanish on the next upgrade (see
[ADR-0004](./docs/adr/0004-shell-function-not-tui.md)'s Amendment 1); the emitted line
works unchanged on every machine, survives Node upgrades, and is a no-op — no output, exit
status 0 — if the package is ever removed, since it's guarded on `ccp` actually being on
`PATH`. Setup then verifies the machine can run the tool at all, using the same Checks
`ccp doctor` exposes, so a problem surfaces once, here, instead of later as an unexplained
failure. Run it again any time — a second run changes nothing — and add `--dry-run` to see
the line it would add without writing it.

Setup adds this line:

```sh
if command -v ccp >/dev/null 2>&1; then eval "$(command ccp shell-init)"; fi
```

It also adds a `[alias]` segment to your prompt showing which Profile the shell is bound
to (`[(default)]` when unbound) — see `shell/ccp.sh` for how it hooks `PS1`.

**Pinning a version.** The install line above always resolves the newest release
compatible with `^1.0.0`. To stay on a known-good combination with an older Claude Code
instead — the entire backward-compatibility mechanism this project offers (see
[ADR-0010](./docs/adr/0010-compatibility-by-observation-not-version-matrix.md)) — install
an exact release tag:

```sh
npm i -g github:giordyreds/claude-code-multi-session#v1.2.0
```

## Usage

```
Usage: ccp <command>

Commands:
  setup              Wire the `ccp` shell function into your shell's startup file and verify the
                     machine can run the tool — the second command after installing
  whoami             Report the bound Profile's identity
  add <alias>        Create a new Profile
  ls                 List every Profile
  login <alias>      Authenticate a Profile and record its resulting identity
  use [alias]        Bind the current shell to a Profile (via the `ccp` shell function); with no
                     Alias, shows an interactive picker
  shell-init         Emit the `ccp` shell function, for a shell startup file to `eval`
  run <alias>        Run a command under a Profile's identity, no shell function required —
                     usage: ccp run <alias> -- <command>
  reconcile <alias>  Accept a drifted Profile's observed identity as its new Expected identity
  sync               Re-render every Profile's settings and repair its Rig sharing
  doctor             Run every Check and report each Contract by name alongside what it found —
                     reports only, never repairs (see `ccp sync`)
  rm <alias> --yes   Permanently remove a Profile, its configuration and its isolated history
  teardown           Undo Setup: remove the shell wiring line it added — never touches Profiles

Flags:
  --version          Print ccp's own version
  --dry-run          With `setup`, print the line it would add instead of writing it
  --help             Print this usage text
```

A typical flow, right after [Install](#install):

```sh
ccp add work        # create a Profile
ccp login work       # authenticate it (opens a browser)
ccp use work         # bind the current shell to it
claude               # usually drops straight into a normal session (see below)
ccp whoami           # confirm which identity you're running as
```

`ccp use` with no Alias opens an interactive picker. `ccp run work -- git push`
runs one command under a Profile without binding the shell at all, so it works from
scripts and non-interactive shells that never sourced `shell/ccp.sh`.

**`ccp doctor`** is the answer to "is it me or is it the tool?" It runs every Check and
reports each Contract by name alongside what it found — including the Claude Code version
this machine's Checks last passed against, an honest record of what was actually verified
here rather than a compatibility table. It only ever reports; it never repairs anything
itself (see `ccp sync`) — run it any time something that worked yesterday stops working
today, with no side effect to worry about.

**A new Profile's first interactive `claude` launch is a separate gate from
`ccp login`** — Claude Code tracks onboarding completion independently of
authentication (see
[ADR-0008](./docs/adr/0008-onboarding-is-a-separate-one-time-gate-from-login.md)).
`ccp login` closes this gate too, automatically, whenever your Default install
(`~/.claude.json`) has itself already completed onboarding — the ordinary case
once you've used `claude` interactively at all on this machine. When it can't
(e.g. a machine where even the Default install has never run `claude`
interactively), the Profile falls back to the one-time manual step this always
used to require: click through the onboarding wizard once, right after
`ccp login`, before scripting against that Profile or relying on it from a
non-interactive shell. Every launch after the first goes straight into a normal
session either way.

## Uninstall

```sh
ccp teardown
npm uninstall -g claude-code-multi-session
```

`ccp teardown` is Setup's inverse: it removes only the shell wiring line `ccp setup`
added, leaving everything else in your startup file untouched, and is safe to run even if
Setup was never run at all. It then reports what it deliberately leaves behind — your
Profiles, still under `ccp`'s state directory — and the command that removes one
(`ccp rm <alias> --yes`), since destroying them as a side effect of removing a shell
helper would throw away conversation history and project state you may still want.
Uninstalling the package removes the `ccp` command itself; the guarded shell line left
behind by Setup becomes a harmless no-op — no output, exit status 0 — rather than an error
on your next shell start.

Neither step touches credential material either way — see [Scope](#scope) for why `ccp`
never has a code path that could. It lives in the system keychain and survives any
filesystem deletion, regardless of what you remove here.

## Scope

- No liveness checking — reports stored login state, honestly labeled as such.
- No automatic login — every browser-opening step is explicit.
- No migration of your existing `~/.claude` install; unbound shells keep using it
  exactly as before.
- No credential storage, backup, or multi-machine sync. `ccp` never has a code path
  that reads or writes credential material — every login is delegated to Claude Code
  itself.

Full rationale and out-of-scope list in the [PRD](https://github.com/giordyreds/claude-code-multi-session/issues/14).

## Releases

Work happens on `development`; releases are cut from `main`, `ccp`'s stable branch, and
tagged there — never from `development` directly, so the install line in
[Install](#install) never hands someone a half-finished tree. The ritual:

1. Bump `version` in `package.json`.
2. Merge `development` into `main`.
3. Tag the merge commit `vX.Y.Z`.
4. Push `main` and the tag.

This is written down because it's easy to skip silently: the install line resolves
against release tags, so a release that's never tagged makes it silently resolve to
nothing useful, for everybody, with no error that points at the cause (see
[ADR-0009](./docs/adr/0009-install-from-github-via-npm.md)).

## Development

```sh
npm run typecheck
npm test        # vitest
npm run build
```

Tests drive the CLI through its single entry point (`runCli` in `src/cli.ts`) with
injected fakes for the `claude` executable, the picker, and the filesystem — see
`docs/adr/` for why, and `CONTEXT.md` for the vocabulary the code and tests use.
