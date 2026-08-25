import type { AuthStatus } from "../claude-port.js";
import type { CliDeps, Command } from "../cli-deps.js";
import { resolveExitCode } from "../command-runner.js";
import { reportError } from "../fs-utils.js";
import { compareToExpected, formatIdentity, formatLiveIdentity } from "../identity.js";
import type { PickerRow } from "../picker.js";
import { loadRegistry, recordDrift, type ProfileRecord, type Registry } from "../registry.js";
import { shellInitScript } from "../shell-init.js";
import { resolveKnownProfile } from "./shared.js";

const RUN_USAGE = "Usage: ccp run <alias> -- <command> [args...]";

/** Binding and execution: `use`, `run`, `shell-init` (ADR-0015). */
export const SHELL_COMMANDS: Record<string, Command> = {
  use: runUse,
  run: runRun,
  "shell-init": runShellInit,
};

/**
 * `ccp use <alias>`: prints the `export CLAUDE_CONFIG_DIR=...` line the `ccp` shell function
 * (ADR-0004) evaluates to bind the calling shell to a Profile. Per ADR-0004, **only** that
 * export statement ever reaches stdout — every diagnostic below goes to stderr, and binding
 * still succeeds (still prints the export) for every diagnostic except an unknown Alias or a
 * hard {@link ClaudePort}/registry failure, neither of which leaves a Profile to bind to.
 *
 * Unlike `ccp login`, `use` never provisions a Profile that isn't already registered — Binding
 * never opens a browser or authenticates (this ticket's own acceptance criteria), and creating a
 * Profile on the fly here would let `ccp use` silently originate one instead of `ccp add`/`ccp
 * login`.
 *
 * With no Alias (ticket #9), the Alias comes from an interactive picker instead of the argument
 * list — see {@link pickAlias}. Everything from here on treats a picked Alias exactly like one
 * typed on the command line, including a fresh {@link ClaudePort#authStatus} query even though
 * the picker already resolved one: the picker can sit open for a while before the user commits,
 * so binding re-checks rather than trusting a possibly-stale snapshot.
 *
 * Verifies the Profile's identity as part of Binding and reports a logged-out or drifted Profile
 * on stderr (ticket #8's Drift detection) — but Binding still succeeds either way. Drift is a
 * warning, never a block: the whole point is that the user finds out *before* running `claude`
 * under the wrong identity, not that Binding refuses to happen.
 */
async function runUse(args: string[], deps: CliDeps): Promise<number> {
  let registry: Registry;
  try {
    registry = await loadRegistry(deps.stateDir);
  } catch (err) {
    return reportError(deps.stderr, err);
  }

  let alias = args[0];
  if (!alias) {
    const picked = await pickAlias(registry, deps);
    if (picked === undefined) return 1;
    alias = picked;
  }

  const record = registry.profiles[alias];
  if (!record) {
    deps.stderr(`Unknown Alias '${alias}': no Profile named '${alias}' is registered. Run 'ccp add ${alias}' first.`);
    return 1;
  }

  let status: AuthStatus;
  try {
    status = await deps.claudePort.authStatus(record.configDir);
  } catch (err) {
    return reportError(deps.stderr, err);
  }

  await reportDriftAndUpdateRegistry(deps, alias, record, status);

  deps.stdout(`export CLAUDE_CONFIG_DIR=${shellQuote(record.configDir)}`);
  return 0;
}

/** Single-quotes `value` for safe `sh`/`zsh` evaluation — the only shape of output ADR-0004
 * permits on stdout. `configDir` is built from an Alias (`registry.ts`'s `isValidAlias` only
 * rejects path traversal, not shell metacharacters), so an unescaped interpolation here would let
 * an Alias like `foo"; rm -rf ~ #` break out of the `export` line the `ccp` shell function evals. */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * `ccp shell-init`: prints the `ccp` shell function's source (`shell/ccp.sh`) on stdout and
 * nothing else, so a shell startup file can `eval` it instead of `source`-ing the file by an
 * absolute path that a Node version manager can silently move out from under it (ADR-0004's
 * Amendment 1, issue #32). `shell/ccp.sh` stays the single source of truth — {@link
 * shellInitScript} reads and returns it rather than this file duplicating its text — so the two
 * can never drift apart.
 *
 * Same stdout discipline ADR-0004 already requires of `ccp use`: this output is `eval`'d too, at
 * the start of every interactive shell, so a diagnostic reaching stdout here would be evaluated as
 * code exactly like a stray warning on `ccp use`'s stdout would be. The one failure mode —
 * `shell/ccp.sh` missing or unreadable — goes to stderr instead.
 */
async function runShellInit(_args: string[], deps: CliDeps): Promise<number> {
  let script: string;
  try {
    script = await shellInitScript();
  } catch (err) {
    return reportError(deps.stderr, err);
  }

  deps.stdout(script);
  return 0;
}

/**
 * `ccp run <alias> -- <command> [args...]` (ticket #11): one-shot execution under a Profile's
 * identity, for scripts, jobs, and other non-interactive callers where the `ccp` shell function
 * was never sourced. Unlike `ccp use`, this never touches the invoking shell at all — no export
 * line, nothing to `eval` — it spawns `<command>` directly with `CLAUDE_CONFIG_DIR` set to the
 * resolved Profile's config directory, hands it the real terminal (stdio inherited), and resolves
 * to its exit code, so stdout, stderr, and exit status all pass through untouched. That's also
 * why `shell/ccp.sh` needs no special case for `run`: it already forwards anything but `use`
 * straight to `command ccp "$@"`.
 *
 * The literal `--` before `<command>` is required, at a fixed position right after `<alias>`, so
 * a command's own flags (`ccp run work -- git log --oneline`) are never mistaken for `ccp run`'s
 * own. An unknown Alias is rejected before `<command>` ever spawns — resolved via
 * {@link resolveKnownProfile}, the same lookup `ccp reconcile` uses.
 */
async function runRun(args: string[], deps: CliDeps): Promise<number> {
  const alias = args[0];
  if (!alias || args[1] !== "--" || args.length < 3) {
    deps.stderr(RUN_USAGE);
    return 1;
  }

  const record = await resolveKnownProfile(deps, alias);
  if (!record) return 1;

  const [command, ...commandArgs] = args.slice(2);
  const env: NodeJS.ProcessEnv = { ...deps.env, CLAUDE_CONFIG_DIR: record.configDir };

  try {
    const result = await deps.commandRunner(command!, commandArgs, { env });
    return resolveExitCode(result);
  } catch (err) {
    return reportError(deps.stderr, err);
  }
}

/**
 * Warns on stderr about a logged-out or drifted Profile — the two states `ccp use` reports
 * without ever blocking Binding — and persists the resulting Drift state (ticket #8) so `ccp ls`
 * can mark it later from stored state alone, with no live check of its own.
 *
 * Only ever touches the stored `drifted` flag when {@link compareToExpected} reports
 * `comparable: true` — an Expected identity on record *and* an Observed identity to compare it
 * against. A Profile that's logged out, or one `claude` reports as logged in without naming both
 * halves (`identity: null`, ADR-0014), leaves whatever Drift state was already recorded exactly
 * as it was: there is nothing observed to prove it's still drifted, or to prove it isn't. This is
 * the entire reason {@link compareToExpected} returns a three-state verdict rather than a
 * boolean — collapsing "not comparable" into `false` here would silently clear a recorded drift
 * flag on every logged-out Profile `ccp use` binds to.
 */
async function reportDriftAndUpdateRegistry(
  deps: { stateDir: string; stderr: (line: string) => void },
  alias: string,
  record: ProfileRecord,
  status: AuthStatus,
): Promise<void> {
  if (!status.loggedIn) {
    deps.stderr(`Warning: Profile '${alias}' is not logged in.`);
    return;
  }

  const expected = record.expectedIdentity;
  const observed = status.identity;
  // Compiler-checked narrowing: `expected`/`observed` must both be non-null past this guard for
  // `formatIdentity` below to even type-check — no hand-written `=== undefined` field checks
  // (issue #48). `compareToExpected` would report `comparable: false` for this same pair; this
  // guard exists anyway so TypeScript itself, not a convention, rules out the drift message
  // below ever running against a half-formed pair.
  if (!expected || !observed) {
    return;
  }

  const verdict = compareToExpected(expected, observed);
  if (!verdict.comparable) {
    // Unreachable given the guard above — `expected`/`observed` are both non-null here, so
    // `compareToExpected` always reports `comparable: true`. Kept as a real check, not an
    // assertion, so this function still type-checks against `DriftVerdict`'s shape on its own.
    return;
  }

  if (verdict.drifted) {
    // Prominent and names both identities, per ticket #8's acceptance criteria — this is the
    // moment that catches "someone logged in directly while a shell was bound" before it bills
    // the wrong Organization.
    deps.stderr(`!!! DRIFT DETECTED for Profile '${alias}' !!!`);
    deps.stderr(`  Expected identity: ${formatIdentity(expected)}`);
    deps.stderr(`  Observed identity: ${formatIdentity(observed)}`);
    deps.stderr(`Binding '${alias}' anyway. Run 'ccp reconcile ${alias}' if the observed identity is now correct.`);
  }

  if (verdict.drifted !== record.drifted) {
    await recordDrift(deps.stateDir, alias, verdict.drifted);
  }
}

/**
 * `ccp use` with no Alias (ticket #9): shows an interactive picker listing every registered
 * Profile alongside the Account/Organization it currently resolves to, and resolves to the
 * chosen Profile's Alias. Resolves `undefined` — with the reason already reported to stderr, or
 * silently for a plain cancellation — whenever `runUse` has nothing to bind: no Profiles are
 * registered, a Profile's identity couldn't be resolved, the picker itself rejects (no
 * interactive terminal — {@link TtyPicker}), or the user cancelled it.
 *
 * Every row's identity is resolved with `Promise.all`, not a sequential loop, so the picker opens
 * as soon as the slowest single Profile resolves rather than after the sum of every Profile's
 * resolution time — this ticket's "opens promptly with several Profiles" acceptance criterion.
 */
async function pickAlias(registry: Registry, deps: CliDeps): Promise<string | undefined> {
  const aliases = Object.keys(registry.profiles).sort((a, b) => a.localeCompare(b));
  if (aliases.length === 0) {
    deps.stderr("No Profiles are registered. Run 'ccp add <alias>' first.");
    return undefined;
  }

  let rows: PickerRow[];
  try {
    rows = await Promise.all(
      aliases.map(async (alias) => {
        const record = registry.profiles[alias]!;
        const status = await deps.claudePort.authStatus(record.configDir);
        return { alias, label: `${alias}: ${formatLiveIdentity(status)}` };
      }),
    );
  } catch (err) {
    reportError(deps.stderr, err);
    return undefined;
  }

  try {
    return await deps.picker.pick(rows);
  } catch (err) {
    reportError(deps.stderr, err);
    return undefined;
  }
}
