# claude-code-multi-session

`ccp` lets one machine hold several Claude Code identities at once, so separate shells
can run under separate accounts simultaneously — a work Team seat in one terminal, a
personal Pro subscription in another — without logging in and out to switch.

It never touches your existing `~/.claude` installation, never reads or stores
credentials, and shares your skills, plugins, hooks and commands across every identity
you add. macOS and Linux, bash or zsh; built as a personal tool, not published. Windows
isn't supported yet (tracked as
[issue #41](https://github.com/giordyreds/claude-code-multi-session/issues/41)) — every
`ccp` subcommand fails fast with a clear message on that platform instead of a confusing
path or permissions error.

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
  binary*, the separate, earlier act of putting the `ccp` command on `PATH` — that word
  stays free for whichever of those puts it there, and never names this.
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

Each [release](https://github.com/giordyreds/claude-code-multi-session/releases) ships a
standalone `ccp` executable with the JavaScript runtime baked in — no Node.js, no
`npm install`. Grab the asset for your platform and put it on your `PATH`.

**While this repository is private** (true today), the asset needs an authenticated
request — a plain `curl` gets a 404, indistinguishable from the asset not existing,
whether or not you're logged in to GitHub anywhere else.
[`gh`](https://cli.github.com/), already authenticated (`gh auth login`), carries that
authentication for you:

```sh
# macOS (Apple Silicon) — swap the pattern for your platform, and the tag for the release
gh release download vX.Y.Z \
  --repo giordyreds/claude-code-multi-session --pattern "ccp-*-darwin-arm64.tar.gz"
tar -xzf ccp-*-darwin-arm64.tar.gz
sudo mv ccp /usr/local/bin/
```

**If this repository is ever made public**, a plain `curl` works and needs nothing but a
shell:

```sh
# macOS (Apple Silicon) — swap the slug for your platform, and vX.Y.Z for the release
curl -fsSL -o ccp.tar.gz \
  https://github.com/giordyreds/claude-code-multi-session/releases/download/vX.Y.Z/ccp-X.Y.Z-darwin-arm64.tar.gz
tar -xzf ccp.tar.gz
sudo mv ccp /usr/local/bin/
```

(It fails with the same 404 today, for the reason above — this isn't a broken command,
it's what a private repo does to an unauthenticated request.)

| Platform | Asset slug |
| --- | --- |
| macOS, Apple Silicon | `darwin-arm64` |
| macOS, Intel | `darwin-x64` |
| Linux, x64 | `linux-x64` |
| Linux, arm64 | `linux-arm64` |

`ccp` itself supports macOS and Linux, bash or zsh (see [Scope](#scope)); the release
pipeline also builds musl variants of the Linux binaries (for Alpine-style distros) and
Windows binaries, but Windows support is explicitly deferred — see
[issue #41](https://github.com/giordyreds/claude-code-multi-session/issues/41) — so there's
nothing for that asset to install onto yet.

Then run Setup:

```sh
ccp setup
```

**Setup** adds the `ccp` shell function to the interactive startup file your shell
actually reads, detected from `$SHELL` — `$ZDOTDIR/.zshrc` (or `~/.zshrc`) for zsh,
`~/.bashrc` for bash or anything else (including an unset `$SHELL`) — by evaluating what
`ccp shell-init` prints, rather than `source`-ing
`shell/ccp.sh` by an absolute path. An absolute path can move — the binary gets replaced,
reinstalled somewhere else, or removed — while the emitted line works unchanged wherever
`ccp` ends up, and is a no-op — no output, exit status 0 — if it's removed entirely, since
it's guarded on `ccp` actually being on `PATH` (see
[ADR-0004](./docs/adr/0004-shell-function-not-tui.md)'s Amendment 1). Setup then verifies
the machine can run the tool at all, using the same Checks `ccp doctor` exposes, so a
problem surfaces once, here, instead of later as an unexplained failure. Run it again any
time — a second run changes nothing — and add `--dry-run` to see the line it would add
without writing it.

Setup adds this line:

```sh
if command -v ccp >/dev/null 2>&1; then eval "$(command ccp shell-init)"; fi
```

It also adds a `[alias]` segment to your prompt showing which Profile the shell is bound
to (`[(default)]` when unbound) — see `shell/ccp.sh` for how it hooks `PS1`.

**Pinning a version.** To stay on a known-good combination with an older Claude Code
instead of always grabbing the latest release — the entire backward-compatibility
mechanism this project offers (see
[ADR-0010](./docs/adr/0010-compatibility-by-observation-not-version-matrix.md)) —
download the asset from that specific release's tag instead of the newest one; the URL
above already names an exact tag (`vX.Y.Z`), so pinning is just not updating it.

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
sudo rm "$(command -v ccp)"
```

`ccp teardown` is Setup's inverse: it removes only the shell wiring line `ccp setup`
added, leaving everything else in your startup file untouched, and is safe to run even if
Setup was never run at all. It then reports what it deliberately leaves behind — your
Profiles, still under `ccp`'s state directory — and the command that removes one
(`ccp rm <alias> --yes`), since destroying them as a side effect of removing a shell
helper would throw away conversation history and project state you may still want.
Removing the binary removes the `ccp` command itself; the guarded shell line left behind
by Setup becomes a harmless no-op — no output, exit status 0 — rather than an error on your
next shell start.

Neither step touches credential material either way — see [Scope](#scope) for why `ccp`
never has a code path that could. It lives in the system keychain and survives any
filesystem deletion, regardless of what you remove here.

## Scope

- Supported platforms: macOS and Linux, with bash or zsh as your login shell — detected
  from `$SHELL`, never assumed from `process.platform` (see
  [ADR-0012](./docs/adr/0012-linux-is-supported-detection-is-universal-windows-is-deferred.md)).
  Windows isn't supported yet: every `ccp` subcommand fails fast with a clear message
  instead of running, so nothing is left half-configured; tracked separately as
  [issue #41](https://github.com/giordyreds/claude-code-multi-session/issues/41).
- No liveness checking — reports stored login state, honestly labeled as such.
- No automatic login — every browser-opening step is explicit.
- No migration of your existing `~/.claude` install; unbound shells keep using it
  exactly as before.
- No credential storage, backup, or multi-machine sync. `ccp` never has a code path
  that reads or writes credential material — every login is delegated to Claude Code
  itself.

Full rationale and out-of-scope list in the [PRD](https://github.com/giordyreds/claude-code-multi-session/issues/14)
and the [Linux-support PRD](https://github.com/giordyreds/claude-code-multi-session/issues/40).

## Releases

Work happens on `development`; releases are cut from `main`, `ccp`'s stable branch, and
tagged there — never from `development` directly, so the binaries a tag publishes are
never built from a half-finished tree. The ritual:

1. Bump `version` in `package.json`.
2. Merge `development` into `main`.
3. Tag the merge commit `vX.Y.Z`.
4. Push `main` and the tag.

Pushing the tag is what matters: it's what
[`.github/workflows/release.yml`](./.github/workflows/release.yml) watches for, and that
workflow is the only thing that builds and publishes the binaries in
[Install](#install). This is written down because it's easy to skip silently: a release
that's never tagged builds and publishes nothing, for everybody, with no error that points
at the cause (see [ADR-0011](./docs/adr/0011-distribute-as-compiled-binaries-via-github-releases.md)).

## Development

```sh
npm install
npm run typecheck
npm test              # vitest
npm run build          # tsc -> dist/, for running ccp from a checkout
npm run build:binaries # bun build --compile -> bin-dist/, the same binaries a release publishes
```

Tests drive the CLI through its single entry point (`runCli` in `src/cli.ts`) with
injected fakes for the `claude` executable, the picker, and the filesystem — see
`docs/adr/` for why, and `CONTEXT.md` for the vocabulary the code and tests use.
