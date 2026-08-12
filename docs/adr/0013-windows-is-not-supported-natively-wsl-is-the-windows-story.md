---
status: accepted
---

# Windows isn't supported natively; WSL is the Windows story

[ADR-0012](./0012-linux-is-supported-detection-is-universal-windows-is-deferred.md) named Windows
"deferred, tracked separately as issue #41," which left open the implication that a native
PowerShell implementation was coming. It isn't. **This resolves that deferral in the other
direction: native Windows is declined, and WSL is how `ccp` runs on a Windows machine.** Issue #41
is closed by this decision rather than scoped by it.

**WSL needs no code, because WSL is Linux by every mechanism `ccp` actually uses.** Inside a WSL2
distro the `linux-x64` binary sees `process.platform === "linux"`, so the `win32` guard never
fires; `/proc/<pid>/environ` exists, so `daemon.ts`'s cleanup works — better than on macOS, where
it still throws; `$SHELL` names bash, so ADR-0012's universal detection wires `~/.bashrc` with no
new branch; and symlinks work on the distro's own filesystem, so `rig.ts`'s `symlink()` sharing
(ADR-0007) works untouched. There is no WSL code path in this project and this decision
deliberately doesn't add one — WSL support is a documentation change and a Check that reports one
more fact, nothing else.

**The claim is documented as unobserved, on purpose.** ADR-0012 opened by insisting its
load-bearing assumption "was checked, not assumed," and reran the `CLAUDE_CONFIG_DIR` isolation
probe against a real Linux Claude Code install before deciding anything. That probe transfers to
WSL2 as far as the Contract goes — same binary, same kernel API, same
`claude auth status --json`-exits-`1`-while-logged-out gotcha — and not one step further. What no
container exercises is the interop boundary: WSL's `PATH` interop, and whether `claude auth login`
reaches a Windows browser. No end-to-end run on a real WSL install has been observed, and the
README says so in those words rather than rounding it up to "supported." Asserting the interop
surface works without looking at it is the inference-over-observation move ADR-0010 already
rejected for version compatibility; it would be no more honest here.

**The one WSL-specific hazard gets named, not branched on.** WSL appends the Windows `PATH` by
default, so a Windows-side Claude Code install appears inside the distro as `/mnt/c/…/claude` —
npm on Windows writes an extensionless `sh` shim next to `claude.cmd`, and `/mnt/c` is normally
mounted without metadata, so everything reads as mode `0777` and `doctor`'s `X_OK` test passes.
That shim resolves `node` through the same interop, so `claude` runs as a *Windows* process holding
a Linux `CLAUDE_CONFIG_DIR` it cannot interpret. If Claude Code responds by falling back to
`%USERPROFILE%\.claude`, the shell is bound to a Profile while the Session runs under the Default
install's identity — a **Phantom binding** (CONTEXT.md), the third instance of the failure shape
ADR-0004's Amendment 1 and ADR-0012's bash-on-macOS fix each exist to prevent, and the reason that
term is now in the glossary instead of being re-narrated by every ADR that meets it. The remedy is
one sentence — install Claude Code inside the distro — and it appears in the two places a Windows
user can encounter it: the `win32` guard message and README's Scope.

**Why native Windows was declined.** Issue #41 listed four POSIX-specific mechanisms; there are
seven, and the three it missed are worse than the ones it found.

| Mechanism | Blocker on native Windows |
| --- | --- |
| Binding (ADR-0004) | A shell function `eval`-ing this program's stdout. No PowerShell equivalent to reuse. |
| `SHELL_WIRING_LINE` (`doctor.ts`) | POSIX `sh` end to end; runs in neither PowerShell nor cmd.exe. |
| `shellQuote` (`cli.ts`) | sh single-quoting. PowerShell's rules differ enough to need a sibling, not an extension. |
| `daemon.ts` | `/proc/<pid>/environ` doesn't exist; reading another process's environment needs its PEB, i.e. native code. |
| **`rig.ts`** | `symlink()` requires Developer Mode or admin. Blocks `ccp add`, not just Binding. |
| **`status-line.ts`** | Renders a POSIX `sh` snippet into every Profile's `settings.json`. *Which* shell Claude Code invokes it with on Windows is an undocumented Contract nobody has probed. |
| **`command-runner.ts`** | `spawn` with `shell: false` can't execute the `.cmd` shim `claude` most likely is on Windows. |

On top of that, ADR-0004's Amendment 1 rests on `shell/ccp.sh` being the single source of truth for
the shell function; a PowerShell prompt is a `prompt` function rather than `PS1`, so that becomes
one source per shell family plus a second `EMBEDDED_*` compile-time define. Adding a second shell
family is the largest piece of work this project has considered, and it would be undertaken for a
platform its maintainer cannot observe.

## Considered Options

- **Implement native PowerShell support properly.** Rejected: the table above is seven parallel
  implementations, not four, and the `status-line.ts` row is an unprobed Claude Code Contract on a
  platform with no machine available to probe it on. WSL delivers the same outcome for a Windows
  user at the cost of a README section.
- **Keep #41 open as a deferral.** Rejected: it had no scope in it and, after this analysis, never
  will. An issue that names a thing nobody intends to do is worse than a closed issue pointing at
  the decision — it reads as a roadmap.
- **Stop building the `windows-x64` release binary.** Rejected: ADR-0011 found the full
  `bun build --compile` matrix costs nothing extra in CI, and that still holds. A Windows user who
  downloads the asset named for their platform and is told exactly what to do instead is better
  served than one who finds no Windows asset and concludes the project abandoned them. The binary's
  single behaviour — printing the WSL remedy — is now the point of shipping it, not an accident of
  the build matrix.
- **Document WSL as plainly supported, on the strength of ADR-0012's Linux probe alone.** Rejected
  as above: the probe covers the Contract and none of the interop surface. The hedge is one
  sentence and it is true.
- **Add a `doctor` Check that fails when `claude` resolves under WSL's automount root.** Rejected,
  though it was the closest call here. It would catch the Phantom binding outright, which is the
  project's usual instinct — but it requires the first per-OS branch in a codebase whose ADR-0012
  principle is that detection is universal and never keyed on the platform, and it would key on an
  automount root that `/etc/wsl.conf` can move. Reporting the resolved path gets most of the
  benefit with none of that, and it improves the Check on macOS and Linux too.
- **Fold the WSL guidance into `doctor` rather than the guard message.** Rejected: `doctor` never
  runs on `win32` — the guard sits ahead of every subcommand — so the guard message is the *only*
  channel to a native-Windows user. Guidance placed anywhere else cannot reach them.

## Consequences

- `checkClaudeOnPath` reports `found at <path>` instead of `found on PATH`. This is a universal
  improvement, not a WSL accommodation: two `claude` installs on one machine are ordinary, and a
  Check that says only "found" can't tell you which one every subsequent Check observed.
- The `win32` guard message no longer cites a tracking issue, because there is no longer one to
  cite. It names the remedy, including the install-inside-the-distro requirement.
- CONTEXT.md gains **Phantom binding**, placed immediately after **Binding** so a reader meets the
  failure mode before Drift, which the entry contrasts against. The term is not new behaviour — it
  names something ADR-0004 A1, ADR-0012, and this ADR each independently described in prose.
- README names WSL as the Windows path in its opening line, asset table, and Scope, and states
  plainly that no end-to-end WSL run has been observed.
- ADR-0012's filename still says `windows-is-deferred`, and is deliberately left alone: ADR-0011
  and README both link to it by name, and a filename is a worse place to learn a decision changed
  than the ADR that changed it. Its Linux content stands unamended.
- Nothing in `shell/ccp.sh`, `daemon.ts`, `rig.ts`, `status-line.ts`, or `command-runner.ts`
  changes. The table above is the reason native Windows was declined, not a list of work now
  scheduled.
- Native Windows remains reopenable. Nothing here is a one-way door: the guard, the binary, and
  the release matrix all survive, so reversing this means writing the PowerShell family, not
  undoing anything decided today.
- The macOS daemon-cleanup gap (`daemon.ts` throws anywhere but Linux, macOS included) stays
  untouched, exactly as ADR-0012 left it — pre-existing and unrelated, and now mildly ironic:
  daemon cleanup works in WSL and not on the platform this tool was built on.
