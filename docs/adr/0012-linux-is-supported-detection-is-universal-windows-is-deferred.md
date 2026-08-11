---
status: accepted
---

# `ccp` supports Linux; shell detection is universal, not per-OS; Windows is explicitly deferred

`ccp` supported only macOS + zsh (PRD #14, README's Scope). The release pipeline (ADR-0011)
already built standalone binaries for Linux and Windows on every tag, deliberately, so that "a
future decision to support another platform is a `src/` change alone." This is that decision —
for Linux. Windows is named and deferred, not attempted, tracked separately as issue #41.

**Before deciding anything, the load-bearing assumption was checked, not assumed.** ADR-0001 and
ADR-0005 established `CLAUDE_CONFIG_DIR` isolation by probing a real macOS Claude Code install,
because Anthropic didn't document it. The same probe was rerun against a real Linux install — this
repo's own `sandbox.Dockerfile` (`node:26-bookworm`), with a real `@anthropic-ai/claude-code`
(2.1.227) — pointing `CLAUDE_CONFIG_DIR` at a fresh directory and confirming: `claude auth status
--json` returns clean, parseable, logged-out JSON (exiting `1`, exactly the gotcha ADR-0005 already
documents for macOS); state is written under that directory only; the default `~/.claude.json` is
created only by an unscoped invocation. The Contract holds on Linux. Separately, `CLAUDE_CONFIG_DIR`
turns out to no longer be purely reverse-engineered as ADR-0001/0005 characterized it — Anthropic's
current docs (`code.claude.com/docs/en/claude-directory`, linking to `/docs/en/env-vars`) now
describe it directly, including an explicit Windows path-mapping note (`%USERPROFILE%\.claude`).
Neither fact changes what's decided below; both are why it was safe to decide anything at all.

**Shell detection is universal, keyed on `$SHELL`, never on `process.platform`.** `ccp setup` and
`ccp doctor` read `$SHELL`, take its basename, and wire `~/.zshrc` (or `$ZDOTDIR/.zshrc`) only when
it names zsh; every other case — bash, an unrecognized shell, or `$SHELL` unset — wires
`~/.bashrc`. This runs identically on `darwin` and `linux`, replacing the previous
unconditional-zsh behavior on both, not adding a second, parallel Linux-only path next to it. That
replacement fixes a bug that already existed on macOS: a Mac user who has switched their login
shell to bash was being wired into `.zshrc`, a file their shell never reads — Binding appeared to
succeed while never taking effect, the exact silent failure ADR-0004's Amendment 1 exists to
prevent. Bash wiring targets `~/.bashrc` only, no `.bash_profile`/`.profile` fallback chain,
mirroring the zsh convention's existing single-file shape. The field carrying this path is renamed
`zshrcPath` → `shellRcPath` throughout `cli.ts`, `doctor.ts`, and `setup.ts` — a field that can hold
`.bashrc` has no business keeping a name that says it can't.

**Windows gets a hard guard, not a Check.** `RunCliOptions` gains a `platform` field (defaulting to
`process.platform`); before any subcommand dispatches, `win32` prints "Windows isn't supported
yet" to stderr and exits non-zero, touching nothing. This is deliberately not a `doctor` Contract:
CONTEXT.md defines a Contract as a behaviour of *Claude Code* this project depends on and doesn't
control, and Windows support is `ccp`'s own declared scope, not Claude Code's behaviour. Folding it
into the Check/Contract machinery would blur a distinction this project has otherwise been careful
about everywhere else.

## Considered Options

- **Detect bash/zsh on Linux only, leave macOS hardcoded to zsh.** Rejected: it would leave the
  bash-on-macOS miswiring bug in place and add a second implementation of the same detection logic
  next to it, for no benefit — the detection is no more expensive to run on `darwin` than on
  `linux`.
- **Support Windows in the same pass, since the binary already builds for it.** Rejected: nearly
  every mechanism Linux support reuses is POSIX-specific — ADR-0004's shell-`eval` binding, the
  `sh`-syntax `SHELL_WIRING_LINE`, `daemon.ts`'s `/proc`-based cleanup, and `cli.ts`'s
  sh-quoting for stdout. None of it carries to PowerShell/cmd.exe without a parallel design effort
  Linux never needed. Recorded as its own deferred issue (#41) rather than silently dropped.
- **Let Windows fail however it happens to fail today**, with no explicit guard. Rejected: nothing
  currently stops `ccp setup` from attempting `.bashrc`/`.zshrc`-shaped logic under
  `%USERPROFILE%`-style paths on `win32`, which is a worse experience than a clear, immediate "not
  supported yet." The guard costs a few lines and commits to nothing about how Windows support, if
  it happens, will eventually work.
- **Fold the Windows guard into `doctor`'s existing Contract/Check list**, as a new named Contract.
  Rejected on vocabulary grounds: a Contract is specifically about Claude Code's behaviour, and
  treating `ccp`'s own platform scope as one would make that word mean two different things in the
  same file.
- **Automate the real-Claude-Code Linux probe in CI**, re-running it on every push. Rejected for the
  same reason ADR-0010 rejected a version-matrix compatibility gate: a Contract that "changes a few
  times a year" doesn't need a per-push check, and a real Claude Code install in CI is an ongoing
  maintenance cost this personal tool doesn't need to carry. The probe stays manual, rerun by hand
  the next time there's real reason to doubt it — the same posture ADR-0010 already takes.

## Consequences

- `defaultZshrcPath(env)` becomes `defaultShellRcPath(env)`; the rename propagates through
  `RunCliOptions`, `DoctorContext`, `writeShellWiringLine`/`removeShellWiringLine`'s parameter, and
  every comment that said "the `.zshrc`."
- `SHELL_WIRING_LINE` and `shell/ccp.sh` need no change — the former is already plain POSIX `sh`,
  and the latter already branches on `$ZSH_VERSION` for its `PROMPT_SUBST` quirk and runs
  unmodified under bash.
- `daemon.ts`'s Linux-only `/proc`-based cleanup and `homedir()`-based path resolution
  (`stateDir`, `installDir`, etc.) already worked correctly per-platform and need no change; only
  the "macOS/zsh only" scope comments in `doctor.ts`, `daemon.ts`, and ADR-0011 needed rewording to
  stop misleading the next reader.
- CI (`.github/workflows/release.yml`) gains a `macos-latest` job alongside the existing
  `ubuntu-latest` one running `npm run typecheck`/`npm test`, so a Linux-motivated change can't
  silently regress the platform `ccp` has actually been used on.
- README's opening line, Scope section, and platform/asset table now name Linux as supported and
  Windows as explicitly deferred (issue #41), rather than the previous blanket "macOS + zsh only."
- The macOS daemon-cleanup gap (`daemon.ts` throws on any platform other than Linux, including
  macOS) is untouched — pre-existing, unrelated to this decision.
- CONTEXT.md needed no glossary change: nothing in it named zsh, macOS, or any platform, so
  Profile/Binding/Setup/Contract/Check all remain accurate unchanged as the platform scope widens
  under them.
