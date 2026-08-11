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

Full glossary in [`CONTEXT.md`](./CONTEXT.md); the design decisions behind them are
recorded as ADRs in [`docs/adr/`](./docs/adr/).

## Install

```sh
git clone <this-repo>
cd claude-code-multi-session
npm install
npm run build
```

Put `dist/bin.js` on your `PATH` (e.g. `npm link`, or symlink it as `ccp`), then source
the shell function in your `.zshrc`:

```sh
source /path/to/claude-code-multi-session/shell/ccp.sh
```

Sourcing it also adds a `[alias]` segment to your prompt showing which Profile the shell
is bound to (`[(default)]` when unbound) — see `shell/ccp.sh` for how it hooks `PS1`.

## Usage

```
Usage: ccp <command>

Commands:
  whoami             Report the bound Profile's identity
  add <alias>        Create a new Profile
  ls                 List every Profile
  login <alias>      Authenticate a Profile and record its resulting identity
  use [alias]        Bind the current shell to a Profile; with no Alias, shows an
                     interactive picker
  run <alias>        Run a command under a Profile's identity, no shell function
                     required — usage: ccp run <alias> -- <command>
  reconcile <alias>  Accept a drifted Profile's observed identity as its new
                     expected identity
  sync               Re-render every Profile's settings and repair its Rig sharing
  rm <alias> --yes   Permanently remove a Profile, its configuration and its
                     isolated history

Flags:
  --version          Print ccp's own version
  --help             Print this usage text
```

A typical setup:

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

## Scope

- No liveness checking — reports stored login state, honestly labeled as such.
- No automatic login — every browser-opening step is explicit.
- No migration of your existing `~/.claude` install; unbound shells keep using it
  exactly as before.
- No credential storage, backup, or multi-machine sync. `ccp` never has a code path
  that reads or writes credential material — every login is delegated to Claude Code
  itself.

Full rationale and out-of-scope list in the [PRD](https://github.com/giordyreds/claude-code-multi-session/issues/14).

## Development

```sh
npm run typecheck
npm test        # vitest
npm run build
```

Tests drive the CLI through its single entry point (`runCli` in `src/cli.ts`) with
injected fakes for the `claude` executable, the picker, and the filesystem — see
`docs/adr/` for why, and `CONTEXT.md` for the vocabulary the code and tests use.
