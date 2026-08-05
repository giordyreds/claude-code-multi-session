import { homedir } from "node:os";
import { join, resolve as resolvePath } from "node:path";
import { resolveBinding } from "./binding.js";
import { ClaudeCliPort, type AuthStatus, type ClaudePort } from "./claude-port.js";
import { resolveExitCode, runCommand, type CommandRunner } from "./command-runner.js";
import { ProcessDaemonPort, type DaemonPort } from "./daemon.js";
import { isDrifted } from "./drift.js";
import { TtyPicker, type Picker, type PickerRow } from "./picker.js";
import {
  addProfile,
  DEFAULT_INSTALL_ALIAS,
  loadRegistry,
  recordDrift,
  recordExpectedIdentity,
  removeProfile,
  type ExpectedIdentity,
  type ProfileRecord,
  type Registry,
} from "./registry.js";
import { repairRig } from "./rig.js";
import { renderSettings } from "./settings.js";

const USAGE =
  "Usage: ccp <command>\n\nCommands:\n  whoami             Report the bound Profile's identity\n  add <alias>        Create a new Profile\n  ls                 List every Profile\n  login <alias>      Authenticate a Profile and record its resulting identity\n  use [alias]        Bind the current shell to a Profile (via the `ccp` shell function); with no\n                     Alias, shows an interactive picker\n  run <alias>        Run a command under a Profile's identity, no shell function required —\n                     usage: ccp run <alias> -- <command>\n  reconcile <alias>  Accept a drifted Profile's observed identity as its new Expected identity\n  sync               Re-render every Profile's settings and repair its Rig sharing\n  rm <alias> --yes   Permanently remove a Profile, its configuration and its isolated history";

const LOGIN_USAGE = "Usage: ccp login <alias>";
const RUN_USAGE = "Usage: ccp run <alias> -- <command> [args...]";
const RECONCILE_USAGE = "Usage: ccp reconcile <alias>";
const RM_USAGE = "Usage: ccp rm <alias> --yes";

const NOT_LOGGED_IN = "(not logged in)";
const NEVER_LOGGED_IN = "(never logged in)";
const UNKNOWN = "(unknown)";
const DRIFTED_MARKER = "[DRIFTED]";

/** The Default install's live settings file — the base every Profile's settings render from
 * (ADR-0002) — and the name the rendered result takes in each Profile's own config directory
 * too, since both are just "the settings file" in their respective directories. */
const BASE_SETTINGS_FILE_NAME = "settings.json";

/** A Profile's optional per-Profile override (ADR-0002's third table row). Lives inside the
 * Profile's own config directory, next to its real identity/history files rather than anywhere
 * shared, and is the file a Profile owner is meant to hand-edit directly — unlike the *rendered*
 * `settings.json` beside it, which {@link renderSettings} refuses to clobber once hand-edited. */
const OVERRIDE_SETTINGS_FILE_NAME = "settings.override.json";

/** The tool's own state directory: holds the Profile registry and every managed Profile's
 * isolated config directory. Overridable via `CCACCT_HOME` so tests — including the zsh
 * integration test, which spawns the real built binary rather than calling {@link runCli}
 * directly — never touch a real `$HOME`. */
function defaultStateDir(env: NodeJS.ProcessEnv): string {
  const override = env.CCACCT_HOME;
  if (override) return resolvePath(override);
  return join(homedir(), ".ccacct");
}

/** The Default install's configuration directory — the source of the Rig shared into every
 * newly added Profile (ADR-0007). Like the rest of this project's identity-resolution
 * assumptions (ADR-0001, ADR-0005), this path is reverse-engineered rather than documented by
 * Anthropic: it's where `claude` reads and writes when no `CLAUDE_CONFIG_DIR` override is in
 * effect. */
function defaultInstallDir(): string {
  return join(homedir(), ".claude");
}

export interface RunCliOptions {
  /** The shell environment to resolve Binding from. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
  /**
   * Test seam: replaces every invocation of the real `claude` executable (see ADR-0005) so
   * `whoami` — and every future identity-resolving command — is testable without spawning it.
   * Defaults to a real {@link ClaudeCliPort}.
   */
  claudePort?: ClaudePort;
  /** Test seam: the tool's own state directory, holding the Profile registry and every managed
   * Profile's isolated config directory. Defaults to `~/.ccacct`, or `$CCACCT_HOME` if set. */
  stateDir?: string;
  /** Test seam: the Default install's configuration directory — the source of the Rig shared
   * into every newly added Profile (ADR-0007). Defaults to `~/.claude`. */
  installDir?: string;
  /** Test seam: replaces `ccp rm`'s best-effort daemon cleanup (ADR-0001) so tests never depend
   * on real OS processes. Defaults to a real {@link ProcessDaemonPort}. */
  daemonPort?: DaemonPort;
  /**
   * Test seam: replaces the interactive picker `ccp use` shows when invoked with no Alias (see
   * ticket #9). Defaults to a real {@link TtyPicker} reading `process.stdin`, drawing on
   * `process.stderr` — never stdout, per ADR-0004.
   */
  picker?: Picker;
  /**
   * Test seam: replaces the real spawn behind `ccp run <alias> -- <command>` (ticket #11), so
   * tests never spawn a real child process. Defaults to a real {@link CommandRunner} that
   * inherits stdio.
   */
  commandRunner?: CommandRunner;
}

/** Every subcommand's resolved dependencies, after {@link runCli} has applied defaults. */
interface CliDeps {
  env: NodeJS.ProcessEnv;
  stdout: (line: string) => void;
  stderr: (line: string) => void;
  claudePort: ClaudePort;
  stateDir: string;
  installDir: string;
  daemonPort: DaemonPort;
  picker: Picker;
  commandRunner: CommandRunner;
}

/**
 * Runs the `ccp` CLI for one invocation and resolves its process exit code. The single seam
 * every subcommand dispatches through — tests drive the whole tool through this one function.
 */
export async function runCli(argv: string[], options: RunCliOptions = {}): Promise<number> {
  const env = options.env ?? process.env;
  const stdout = options.stdout ?? ((line: string) => console.log(line));
  const stderr = options.stderr ?? ((line: string) => console.error(line));
  const claudePort = options.claudePort ?? new ClaudeCliPort();
  const stateDir = options.stateDir ?? defaultStateDir(env);
  const installDir = options.installDir ?? defaultInstallDir();
  const daemonPort = options.daemonPort ?? new ProcessDaemonPort();
  const picker = options.picker ?? new TtyPicker();
  const commandRunner = options.commandRunner ?? runCommand;

  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") {
    stdout(USAGE);
    return 0;
  }

  const deps: CliDeps = { env, stdout, stderr, claudePort, stateDir, installDir, daemonPort, picker, commandRunner };

  switch (argv[0]) {
    case "whoami":
      return runWhoami(deps);
    case "add":
      return runAdd({ alias: argv[1], stateDir, installDir, stdout, stderr });
    case "ls":
      return runLs(deps);
    case "login":
      return runLogin(argv.slice(1), { stateDir, installDir, stdout, stderr, claudePort });
    case "use":
      return runUse(argv[1], deps);
    case "run":
      return runRun(argv.slice(1), deps);
    case "reconcile":
      return runReconcile(argv[1], { stateDir, stdout, stderr, claudePort });
    case "sync":
      return runSync({ stateDir, installDir, stdout, stderr });
    case "rm":
      return runRm(argv.slice(1), deps);
    default:
      stderr(`Unknown command '${argv[0]}'. ${USAGE}`);
      return 1;
  }
}

/**
 * `ccp whoami`: reports the bound Profile's Alias and the Account/Organization it resolves to.
 * An unbound shell reports the Default install's identity under the `(default)` Alias — never a
 * blank — since under ADR-0003 unbound means the Default install, not "no identity".
 */
async function runWhoami(deps: CliDeps): Promise<number> {
  const binding = resolveBinding(deps.env);
  const alias = binding.bound ? binding.alias : DEFAULT_INSTALL_ALIAS;
  const configDir = binding.bound ? binding.configDir : undefined;

  let status: AuthStatus;
  try {
    status = await deps.claudePort.authStatus(configDir);
  } catch (err) {
    return reportError(deps.stderr, err);
  }

  deps.stdout(formatIdentity(alias, status));
  return 0;
}

/** Prints an error's message to `stderr` and resolves the standard failure exit code — the one
 * shape every command's fallible step reports through. */
function reportError(stderr: (line: string) => void, err: unknown): number {
  stderr(errorMessage(err));
  return 1;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * `ccp login <alias>`: triggers Anthropic's own interactive login flow (it opens a browser),
 * scoped to the named Profile's own config directory, then records the resulting Account and
 * Organization as that Profile's expected identity (ADR-0006). Never called by any other
 * command — Login stays explicit precisely because it opens a browser (CONTEXT.md's Login).
 *
 * `alias` need not have gone through `ccp add` beforehand — an alias with no existing registry
 * entry is provisioned by `addProfile` on the spot, so `ccp login` still works standalone. An
 * alias `ccp add` already created is reused as-is, so logging in never disturbs a Profile's
 * existing (and possibly already-populated) registry entry beyond its Expected identity.
 */
async function runLogin(
  args: string[],
  deps: {
    stateDir: string;
    installDir: string;
    stdout: (line: string) => void;
    stderr: (line: string) => void;
    claudePort: ClaudePort;
  },
): Promise<number> {
  const alias = args[0];
  if (!alias) {
    deps.stderr(LOGIN_USAGE);
    return 1;
  }

  let configDir: string;
  try {
    const registry = await loadRegistry(deps.stateDir);
    const existing = registry.profiles[alias];
    configDir = existing ? existing.configDir : (await addProfile(deps.stateDir, alias, deps.installDir)).configDir;
  } catch (err) {
    return reportError(deps.stderr, err);
  }

  try {
    await deps.claudePort.login(configDir);
  } catch (err) {
    return reportError(deps.stderr, err);
  }

  let status: AuthStatus;
  try {
    status = await deps.claudePort.authStatus(configDir);
  } catch (err) {
    return reportError(deps.stderr, err);
  }

  if (!status.loggedIn) {
    deps.stderr(`'${alias}' finished the login flow but is still not logged in.`);
    return 1;
  }

  // A logged-in status without both fields is permitted by AuthStatus's shape (ADR-0005), even
  // though the real `claude auth status --json` never omits them. Recording a placeholder in
  // their place would fabricate Expected identity data instead of honestly reporting the gap, so
  // this fails loudly rather than persisting anything.
  if (status.email === undefined || status.orgName === undefined) {
    deps.stderr(`'${alias}' logged in, but claude did not report an Account email or Organization — nothing was recorded.`);
    return 1;
  }

  await recordExpectedIdentity(deps.stateDir, alias, { email: status.email, orgName: status.orgName });

  deps.stdout(formatIdentity(alias, status));
  return 0;
}

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
async function runUse(aliasArg: string | undefined, deps: CliDeps): Promise<number> {
  let registry: Registry;
  try {
    registry = await loadRegistry(deps.stateDir);
  } catch (err) {
    return reportError(deps.stderr, err);
  }

  let alias = aliasArg;
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
 * Loads the registry and looks up `alias`'s entry, reporting an actionable error to stderr — and
 * resolving `undefined` — when the registry can't be read or `alias` isn't registered. The one
 * lookup `ccp reconcile` and `ccp run` use (`ccp use` inlines the same lookup itself — see
 * {@link runUse} — since it already has the registry in hand from resolving a picked Alias).
 */
async function resolveKnownProfile(
  deps: { stateDir: string; stderr: (line: string) => void },
  alias: string,
): Promise<ProfileRecord | undefined> {
  let registry;
  try {
    registry = await loadRegistry(deps.stateDir);
  } catch (err) {
    reportError(deps.stderr, err);
    return undefined;
  }

  const record = registry.profiles[alias];
  if (!record) {
    deps.stderr(`Unknown Alias '${alias}': no Profile named '${alias}' is registered. Run 'ccp add ${alias}' first.`);
    return undefined;
  }

  return record;
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
 * Only ever touches the stored `drifted` flag when this check actually had enough to compare —
 * an Expected identity on record *and* a fully-reported observed identity. A Profile that's
 * logged out, or one `claude` reports as logged in without email/orgName (permitted by
 * {@link AuthStatus}'s shape — ADR-0005), leaves whatever Drift state was already recorded
 * exactly as it was: there is nothing observed to prove it's still drifted, or to prove it isn't.
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

  const { expectedIdentity } = record;
  const { email, orgName } = status;
  if (!expectedIdentity || email === undefined || orgName === undefined) {
    return;
  }

  const drifted = isDrifted(expectedIdentity, status);
  if (drifted) {
    // Prominent and names both identities, per ticket #8's acceptance criteria — this is the
    // moment that catches "someone logged in directly while a shell was bound" before it bills
    // the wrong Organization.
    deps.stderr(`!!! DRIFT DETECTED for Profile '${alias}' !!!`);
    deps.stderr(`  Expected identity: ${formatAccountAndOrg(expectedIdentity)}`);
    deps.stderr(`  Observed identity: ${formatAccountAndOrg({ email, orgName })}`);
    deps.stderr(`Binding '${alias}' anyway. Run 'ccp reconcile ${alias}' if the observed identity is now correct.`);
  }

  if (drifted !== record.drifted) {
    await recordDrift(deps.stateDir, alias, drifted);
  }
}

/**
 * `ccp reconcile <alias>`: Reconciliation (CONTEXT.md) — accepts a Profile's currently observed
 * identity as truth and records it as the new Expected identity, resolving Drift. Reads identity
 * the exact same way Drift detection does, via {@link ClaudePort.authStatus}; never calls
 * {@link ClaudePort.login}, so it can never re-authenticate or open a browser, per ticket #8's
 * acceptance criteria.
 */
async function runReconcile(
  alias: string | undefined,
  deps: { stateDir: string; stdout: (line: string) => void; stderr: (line: string) => void; claudePort: ClaudePort },
): Promise<number> {
  if (!alias) {
    deps.stderr(RECONCILE_USAGE);
    return 1;
  }

  const record = await resolveKnownProfile(deps, alias);
  if (!record) return 1;

  let status: AuthStatus;
  try {
    status = await deps.claudePort.authStatus(record.configDir);
  } catch (err) {
    return reportError(deps.stderr, err);
  }

  if (!status.loggedIn) {
    deps.stderr(`Cannot reconcile '${alias}': it is not logged in, so there is no observed identity to accept as truth.`);
    return 1;
  }
  if (status.email === undefined || status.orgName === undefined) {
    deps.stderr(`Cannot reconcile '${alias}': claude did not report an Account email or Organization.`);
    return 1;
  }

  const identity: ExpectedIdentity = { email: status.email, orgName: status.orgName };
  await recordExpectedIdentity(deps.stateDir, alias, identity);

  deps.stdout(`Reconciled '${alias}': Expected identity is now ${formatAccountAndOrg(identity)}.`);
  return 0;
}

/**
 * `ccp rm <alias>`: permanently removes a Profile — its registry entry, its isolated config
 * directory (history included), and, on a best-effort basis, its background daemon (ADR-0001).
 * Never removes the Default install (checked here by name, ahead of even the confirmation
 * prompt, so no confirmation wording ever has to talk about it) — {@link removeProfile} enforces
 * the same rule again, since it's reachable directly too.
 *
 * Requires an explicit `--yes` (or `-y`), named in the acceptance criteria as the point of the
 * confirmation: irreversibly losing a Profile's isolated history. Withheld, this changes nothing
 * — no daemon touched, no directory removed, no registry write.
 *
 * Daemon cleanup runs *after* {@link removeProfile} succeeds, not before: {@link removeProfile}
 * can still fail (a filesystem error, a race), and it must stay all-or-nothing — the registry
 * entry and config directory either both go or neither does. Running the daemon step last means a
 * failed removal never leaves a Profile alive with its daemon already killed out from under it.
 * The daemon step's own failure only ever warns (ticket's own acceptance criteria: best-effort,
 * never blocking) — by the time it runs, the removal it might fail to clean up after has already
 * succeeded. Binding to the alias being removed is reported the same way `ccp use`'s Drift is: a
 * warning on stderr, never a block, since a shell already bound is Binding's own property
 * (CONTEXT.md) and clears on its own once nothing is left to point at.
 */
async function runRm(args: string[], deps: CliDeps): Promise<number> {
  const alias = args[0];
  if (!alias) {
    deps.stderr(RM_USAGE);
    return 1;
  }

  if (alias === DEFAULT_INSTALL_ALIAS) {
    deps.stderr(`'${DEFAULT_INSTALL_ALIAS}' is the Default install and can never be removed.`);
    return 1;
  }

  const record = await resolveKnownProfile(deps, alias);
  if (!record) return 1;

  const confirmed = args.slice(1).some((arg) => arg === "--yes" || arg === "-y");
  if (!confirmed) {
    deps.stderr(
      `Removing '${alias}' permanently deletes its configuration and isolated history — this cannot be undone. Re-run 'ccp rm ${alias} --yes' to confirm.`,
    );
    return 1;
  }

  const binding = resolveBinding(deps.env);
  if (binding.bound && binding.alias === alias) {
    deps.stderr(
      `Warning: the current shell is bound to '${alias}'. It will keep pointing at a now-deleted configuration until it's rebound with 'ccp use'.`,
    );
  }

  try {
    await removeProfile(deps.stateDir, alias);
  } catch (err) {
    return reportError(deps.stderr, err);
  }

  try {
    await deps.daemonPort.stopDaemon(record.configDir);
  } catch (err) {
    deps.stderr(`Warning: could not clean up the background daemon for '${alias}': ${err instanceof Error ? err.message : String(err)}`);
  }

  deps.stdout(`Removed Profile '${alias}'.`);
  return 0;
}

/**
 * Renders an identity report shared by `whoami` and `login`. Account/Organization fall back to
 * an explicit `(not logged in)` — a Profile can be Bound but not logged in (CONTEXT.md's Login)
 * — rather than ever printing a blank. A logged-in status missing its email/orgName (permitted
 * by {@link AuthStatus}'s shape, even though the real `claude auth status --json` always
 * supplies both — ADR-0005) falls back to `(unknown)` instead: reusing `(not logged in)` there
 * would be an outright false statement, not an honest fallback.
 */
function formatIdentity(alias: string, status: AuthStatus): string {
  const account = !status.loggedIn ? NOT_LOGGED_IN : status.email ?? UNKNOWN;
  const organization = !status.loggedIn ? NOT_LOGGED_IN : status.orgName ?? UNKNOWN;
  return [`Alias:        ${alias}`, `Account:      ${account}`, `Organization: ${organization}`].join("\n");
}

/**
 * `ccp add <alias>`: creates a Profile with its own isolated config directory under the tool's
 * state directory and registers its Alias. Alias validity — uniqueness, and the reserved
 * {@link DEFAULT_INSTALL_ALIAS} sentinel — is enforced by {@link addProfile} itself, so a
 * rejection here always means the registry was left exactly as it was.
 */
async function runAdd(deps: {
  alias: string | undefined;
  stateDir: string;
  installDir: string;
  stdout: (line: string) => void;
  stderr: (line: string) => void;
}): Promise<number> {
  const { alias } = deps;
  if (!alias) {
    deps.stderr("Usage: ccp add <alias>");
    return 1;
  }

  try {
    const result = await addProfile(deps.stateDir, alias, deps.installDir);
    deps.stdout(`Created Profile '${result.alias}' at ${result.configDir}`);
    return 0;
  } catch (err) {
    return reportError(deps.stderr, err);
  }
}

/**
 * `ccp ls`: lists every managed Profile with its recorded Expected identity, or an explicit
 * never-logged-in state (CONTEXT.md's Login hasn't happened yet for any Profile this tool can
 * create), followed by the Default install's row. Per ADR-0003, that row is never migrated or
 * mutated and must show its real, live identity rather than a blank — the whole reason `ccp ls`
 * exists is to stop the expensive account from being used by accident.
 *
 * A managed Profile's row also marks Drift (ticket #8) distinctly when the registry's stored
 * `drifted` flag — set the last time `ccp use` checked it — is `true`. This never triggers its
 * own {@link ClaudePort.authStatus} call per Profile: the reported state is stored identity,
 * presented honestly as such, not a live re-check that a token still works.
 */
async function runLs(deps: CliDeps): Promise<number> {
  let profiles;
  try {
    profiles = (await loadRegistry(deps.stateDir)).profiles;
  } catch (err) {
    return reportError(deps.stderr, err);
  }

  const lines = Object.entries(profiles)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([alias, record]) => {
      const identity = record.expectedIdentity ? formatAccountAndOrg(record.expectedIdentity) : NEVER_LOGGED_IN;
      const driftMarker = record.drifted ? ` ${DRIFTED_MARKER}` : "";
      return `${alias}: ${identity}${driftMarker}`;
    });

  let defaultStatus: AuthStatus;
  try {
    defaultStatus = await deps.claudePort.authStatus();
  } catch (err) {
    return reportError(deps.stderr, err);
  }

  lines.push(`${DEFAULT_INSTALL_ALIAS}: ${formatLiveIdentity(defaultStatus)} [unmanaged]`);

  deps.stdout(lines.join("\n"));
  return 0;
}

/** Renders an (Account, Organization) pair the way both a recorded Expected identity and a live
 * {@link AuthStatus} are shown in `ccp ls` (and a Drift warning in `ccp use`) — the one shape
 * every call site shares. */
function formatAccountAndOrg(identity: { email: string; orgName: string }): string {
  return `${identity.email} (${identity.orgName})`;
}

/** Renders a live {@link AuthStatus} the way `ccp ls`'s Default-install row and the picker's rows
 * (ticket #9) both need it: an explicit `(not logged in)` rather than a blank, otherwise the
 * resolved Account/Organization pair. */
function formatLiveIdentity(status: AuthStatus): string {
  return !status.loggedIn
    ? NOT_LOGGED_IN
    : formatAccountAndOrg({ email: status.email ?? UNKNOWN, orgName: status.orgName ?? UNKNOWN });
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

/**
 * `ccp sync`: brings every registered Profile back in line with the Rig and the base settings
 * (ticket #12) — the maintenance counterpart to `ccp add`, which only ever assembles a Profile
 * once, at creation. Every Profile is attempted regardless of an earlier one's outcome: a broken
 * Profile is reported and skipped, per this ticket's acceptance criteria, rather than aborting
 * the run and leaving every later Profile un-synced too.
 *
 * Settings render from the Default install's live settings file plus this Profile's own
 * {@link OVERRIDE_SETTINGS_FILE_NAME} — a hand-authored file distinct from the *rendered*
 * settings file beside it, which {@link renderSettings} refuses to clobber once hand-edited
 * (ticket #7). That refusal surfaces here as one Profile's line reading `SKIPPED`, never a thrown
 * error that would stop the rest of the run. Both repair steps report whether they actually
 * changed anything, so running `sync` again immediately, with nothing left to fix, reports no
 * changes for every Profile the second time.
 *
 * "What was skipped" (this ticket's own words) means a whole Profile `sync` couldn't act on, not
 * an individual Rig item absent from the Default install: {@link repairRig} already treats that
 * as ordinary, silent-by-design state (Spike 0001's `agents`/`commands` finding, same as
 * {@link shareRig} before it), and naming it in every Profile's line on every run would turn
 * permanently-normal state into noise that drowns out the one line that actually needs attention.
 */
async function runSync(deps: {
  stateDir: string;
  installDir: string;
  stdout: (line: string) => void;
  stderr: (line: string) => void;
}): Promise<number> {
  let profiles;
  try {
    profiles = (await loadRegistry(deps.stateDir)).profiles;
  } catch (err) {
    return reportError(deps.stderr, err);
  }

  const aliases = Object.keys(profiles).sort((a, b) => a.localeCompare(b));
  if (aliases.length === 0) {
    deps.stdout("No Profiles to sync.");
    return 0;
  }

  let anySkipped = false;
  const lines: string[] = [];
  for (const alias of aliases) {
    const result = await syncProfile(alias, profiles[alias]!, deps.installDir);
    lines.push(result.line);
    if (result.skipped) anySkipped = true;
  }

  deps.stdout(lines.join("\n"));
  return anySkipped ? 1 : 0;
}

/** One Profile's outcome from a single `ccp sync` pass. */
interface ProfileSyncResult {
  /** The report line `runSync` prints for this Profile — either what changed, `no changes`, or a
   * `SKIPPED` line naming why. */
  line: string;
  /** Whether this Profile's own problem (most commonly {@link renderSettings}'s hand-edit
   * refusal) kept it from syncing — drives `runSync`'s non-zero exit code. */
  skipped: boolean;
}

/**
 * Syncs one Profile: repairs its Rig sharing, then re-renders its settings. Never throws — either
 * step's failure (most commonly {@link renderSettings}'s hand-edit refusal) is caught and turned
 * into that Profile's own `SKIPPED` line, so one Profile's problem can never take the rest of
 * `ccp sync`'s run down with it.
 */
async function syncProfile(alias: string, record: ProfileRecord, installDir: string): Promise<ProfileSyncResult> {
  const changes: string[] = [];

  try {
    const { repaired } = await repairRig(installDir, record.configDir);
    if (repaired.length > 0) changes.push(`Rig repaired (${repaired.join(", ")})`);
  } catch (err) {
    return { line: `${alias}: SKIPPED — ${errorMessage(err)}`, skipped: true };
  }

  try {
    const result = await renderSettings({
      baseSettingsPath: join(installDir, BASE_SETTINGS_FILE_NAME),
      overrideSettingsPath: join(record.configDir, OVERRIDE_SETTINGS_FILE_NAME),
      outputSettingsPath: join(record.configDir, BASE_SETTINGS_FILE_NAME),
    });
    if (result.changed) changes.push("settings re-rendered");
  } catch (err) {
    return { line: `${alias}: SKIPPED — ${errorMessage(err)}`, skipped: true };
  }

  return {
    line: changes.length > 0 ? `${alias}: ${changes.join("; ")}` : `${alias}: no changes`,
    skipped: false,
  };
}
