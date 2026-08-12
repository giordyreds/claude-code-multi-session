import { homedir } from "node:os";
import { basename, join, resolve as resolvePath } from "node:path";
import { resolveBinding } from "./binding.js";
import { ClaudeCliPort, type AuthStatus, type ClaudePort } from "./claude-port.js";
import { resolveExitCode, runCommand, type CommandRunner } from "./command-runner.js";
import { ProcessDaemonPort, type DaemonPort } from "./daemon.js";
import {
  CONTRACT_CLAUDE_ON_PATH,
  CONTRACT_STATE_DIRECTORY,
  LEGACY_STATE_DIR_NAME,
  loadVerifiedVersion,
  recordVerifiedVersion,
  resolveClaudeVersion,
  runDoctorChecks,
  SHELL_WIRING_LINE,
  shellWiringPresent,
} from "./doctor.js";
import { isDrifted } from "./drift.js";
import { seedOnboardingState, type OnboardingSeeder } from "./onboarding.js";
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
import { removeShellWiringLine, writeShellWiringLine } from "./setup.js";
import { shellInitScript } from "./shell-init.js";
import { packageVersion } from "./version.js";

const USAGE =
  "Usage: ccp <command>\n\nCommands:\n  setup              Wire the `ccp` shell function into your shell's startup file and verify the\n                     machine can run the tool — the second command after installing\n  whoami             Report the bound Profile's identity\n  add <alias>        Create a new Profile\n  ls                 List every Profile\n  login <alias>      Authenticate a Profile and record its resulting identity\n  use [alias]        Bind the current shell to a Profile (via the `ccp` shell function); with no\n                     Alias, shows an interactive picker\n  shell-init         Emit the `ccp` shell function, for a shell startup file to `eval`\n  run <alias>        Run a command under a Profile's identity, no shell function required —\n                     usage: ccp run <alias> -- <command>\n  reconcile <alias>  Accept a drifted Profile's observed identity as its new Expected identity\n  sync               Re-render every Profile's settings and repair its Rig sharing\n  doctor             Run every Check and report each Contract by name alongside what it found —\n                     reports only, never repairs (see `ccp sync`)\n  rm <alias> --yes   Permanently remove a Profile, its configuration and its isolated history\n  teardown           Undo Setup: remove the shell wiring line it added — never touches Profiles\n\nFlags:\n  --version          Print ccp's own version\n  --dry-run          With `setup`, print the line it would add instead of writing it\n  --help             Print this usage text";

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
 * isolated config directory. Overridable via `CCP_HOME` so tests — including the zsh
 * integration test, which spawns the real built binary rather than calling {@link runCli}
 * directly — never touch a real `$HOME`. */
function defaultStateDir(env: NodeJS.ProcessEnv): string {
  const override = env.CCP_HOME;
  if (override) return resolvePath(override);
  return join(homedir(), ".ccp");
}

/** The Default install's configuration directory — the source of the Rig shared into every
 * newly added Profile (ADR-0007). Like the rest of this project's identity-resolution
 * assumptions (ADR-0001, ADR-0005), this path is reverse-engineered rather than documented by
 * Anthropic: it's where `claude` reads and writes when no `CLAUDE_CONFIG_DIR` override is in
 * effect. */
function defaultInstallDir(): string {
  return join(homedir(), ".claude");
}

/** Where the Default install's own `.claude.json` lives — confirmed by probe (ADR-0008's
 * amendment) to be the literal home-directory root, a *sibling* of {@link defaultInstallDir}'s
 * `~/.claude`, never nested inside it. Onboarding state (`hasCompletedOnboarding`,
 * `lastOnboardingVersion`) lives in this file, not under `~/.claude/`, for the unbound Default
 * install specifically — a bound Profile's own copy, by contrast, lives inside its
 * `CLAUDE_CONFIG_DIR` (see {@link seedOnboardingState}'s doc comment). */
function defaultInstallStateFilePath(): string {
  return join(homedir(), ".claude.json");
}

/** Where a state directory under the pre-rename name (issue #31) would live — `~/.ccacct`, the
 * name `defaultStateDir` used before it became `~/.ccp`. `ccp doctor`'s Legacy state directory
 * Check looks here for detection only; nothing ever reads or moves what it finds. */
function defaultLegacyStateDir(): string {
  return join(homedir(), LEGACY_STATE_DIR_NAME);
}

/**
 * The shell startup file a user's actual interactive shell reads — detected from `$SHELL` alone,
 * never from `process.platform` (issue #40, ADR-0012): this runs identically on `darwin` and
 * `linux`, one code path rather than a macOS path and a separate Linux path. `$SHELL`'s basename
 * names zsh: `$ZDOTDIR/.zshrc` when the zsh dot-directory environment variable is set, `~/.zshrc`
 * otherwise — unchanged from before this generalized (issue #28's Setup decisions). Every other
 * case — bash, any other shell name, or `$SHELL` unset entirely — resolves to `~/.bashrc`, no
 * `.bash_profile`/`.profile` fallback chain, mirroring the zsh convention's single-file shape.
 * `ccp doctor`'s Shell wiring Check reads whichever file this resolves to; it never writes to it.
 */
export function defaultShellRcPath(env: NodeJS.ProcessEnv): string {
  const shellName = basename(env.SHELL || "");
  if (shellName === "zsh") {
    const dotDir = env.ZDOTDIR || homedir();
    return join(dotDir, ".zshrc");
  }
  return join(homedir(), ".bashrc");
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
   * Profile's isolated config directory. Defaults to `~/.ccp`, or `$CCP_HOME` if set. */
  stateDir?: string;
  /** Test seam: the Default install's configuration directory — the source of the Rig shared
   * into every newly added Profile (ADR-0007). Defaults to `~/.claude`. */
  installDir?: string;
  /** Test seam: the Default install's own `.claude.json` — a *file* path, and a sibling of
   * `installDir` rather than something inside it (see {@link defaultInstallStateFilePath}).
   * Source for `ccp login`'s onboarding pre-seed (issue #27). Defaults to `~/.claude.json`. */
  installStateFilePath?: string;
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
  /**
   * Test seam: replaces `ccp login`'s best-effort onboarding pre-seed attempt (issue #27), so
   * tests can exercise its "warn, never fail Login" behaviour without depending on real
   * filesystem permission errors. Defaults to the real {@link seedOnboardingState}.
   */
  onboardingSeeder?: OnboardingSeeder;
  /** Test seam: where a state directory under the pre-rename name (issue #31) would live, for
   * `ccp doctor`'s Legacy state directory Check. Defaults to `~/.ccacct`. */
  legacyStateDir?: string;
  /** Test seam: the shell startup file `ccp doctor`'s Shell wiring Check reads, and `ccp setup`/
   * `ccp teardown` write to. Defaults to {@link defaultShellRcPath}'s detection from `$SHELL`. */
  shellRcPath?: string;
  /** Test seam: the platform this invocation runs on, for the Windows hard guard (issue #40).
   * Defaults to `process.platform`. */
  platform?: string;
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
  const installStateFilePath = options.installStateFilePath ?? defaultInstallStateFilePath();
  const daemonPort = options.daemonPort ?? new ProcessDaemonPort();
  const picker = options.picker ?? new TtyPicker();
  const commandRunner = options.commandRunner ?? runCommand;
  const onboardingSeeder = options.onboardingSeeder ?? seedOnboardingState;
  const legacyStateDir = options.legacyStateDir ?? defaultLegacyStateDir();
  const shellRcPath = options.shellRcPath ?? defaultShellRcPath(env);
  const platform = options.platform ?? process.platform;

  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") {
    stdout(USAGE);
    return 0;
  }

  // Answered before the command switch, since it is a flag rather than a command and prints
  // nothing but the version — the shape a bug report or a script can quote verbatim (ADR-0010).
  if (argv[0] === "--version") {
    try {
      stdout(await packageVersion());
    } catch (err) {
      return reportError(stderr, err);
    }
    return 0;
  }

  // The Windows hard guard (issue #40, ADR-0012): checked before any subcommand dispatches below,
  // so `win32` never runs a Check or touches a file. Deliberately not a `doctor` Contract/Check —
  // Windows support is `ccp`'s own declared platform scope, not a behaviour of Claude Code.
  //
  // The message names the remedy rather than a tracking issue, because under ADR-0013 there is
  // nothing left to track: native Windows is declined, not deferred, and WSL is the answer. The
  // "inside your distro, not on the Windows side" clause is the whole reason this is more than one
  // sentence — a Windows-side `claude` reached through WSL's `PATH` interop can't interpret the
  // Linux `CLAUDE_CONFIG_DIR` Binding hands it, which is a Phantom binding (CONTEXT.md) and the
  // only WSL-specific hazard worth spending a line on. This is the one place that warning reaches
  // the only user who can hit it.
  if (platform === "win32") {
    stderr(
      "Windows isn't supported natively. Run ccp inside WSL: install the linux-x64 binary in your " +
        "distro, and install Claude Code inside the distro too — not on the Windows side. See " +
        "https://github.com/giordyreds/claude-code-multi-session#scope",
    );
    return 1;
  }

  const deps: CliDeps = { env, stdout, stderr, claudePort, stateDir, installDir, daemonPort, picker, commandRunner };

  switch (argv[0]) {
    case "setup":
      return runSetup(argv.slice(1), { env, claudePort, stateDir, installDir, installStateFilePath, legacyStateDir, shellRcPath, stdout, stderr });
    case "whoami":
      return runWhoami(deps);
    case "add":
      return runAdd({ alias: argv[1], stateDir, installDir, stdout, stderr });
    case "ls":
      return runLs(deps);
    case "login":
      return runLogin(argv.slice(1), { stateDir, installDir, installStateFilePath, stdout, stderr, claudePort, onboardingSeeder });
    case "use":
      return runUse(argv[1], deps);
    case "shell-init":
      return runShellInit(deps);
    case "run":
      return runRun(argv.slice(1), deps);
    case "reconcile":
      return runReconcile(argv[1], { stateDir, stdout, stderr, claudePort });
    case "sync":
      return runSync({ stateDir, installDir, stdout, stderr });
    case "doctor":
      return runDoctor({ env, claudePort, stateDir, installDir, installStateFilePath, legacyStateDir, shellRcPath, stdout, stderr });
    case "rm":
      return runRm(argv.slice(1), deps);
    case "teardown":
      return runTeardown({ shellRcPath, stateDir, stdout, stderr });
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
 *
 * Also attempts to pre-seed the Profile's onboarding state (issue #27, ADR-0008's amendment) right
 * after `login` succeeds, so the Profile's first *interactive* `claude` launch skips the one-time
 * onboarding wizard instead of requiring it as a separate manual step. Best-effort: a failure here
 * only ever warns, never fails `ccp login` itself, since {@link seedOnboardingState} touches
 * Claude Code's own undocumented state file rather than anything this tool owns.
 */
async function runLogin(
  args: string[],
  deps: {
    stateDir: string;
    installDir: string;
    installStateFilePath: string;
    stdout: (line: string) => void;
    stderr: (line: string) => void;
    claudePort: ClaudePort;
    onboardingSeeder: OnboardingSeeder;
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

  try {
    await deps.onboardingSeeder(deps.installStateFilePath, configDir);
  } catch (err) {
    deps.stderr(`Warning: could not pre-seed onboarding state for '${alias}': ${errorMessage(err)}`);
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
async function runShellInit(deps: { stdout: (line: string) => void; stderr: (line: string) => void }): Promise<number> {
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

/** The two Contract names (`doctor.ts`'s `runDoctorChecks` output) whose own Check failing is the
 * *only* thing allowed to fail `ccp setup` (issue #35's fixed fatal/non-fatal rule) — every other
 * Check's problem is still reported, but Setup succeeds anyway, matching the posture already
 * taken for onboarding pre-seeding: somebody else's Contract changing is not this tool's error.
 * Built from `doctor.ts`'s own exported constants, not retyped string literals, so a rename of
 * either Check's name there can never silently desync from this rule. */
const SETUP_FATAL_CONTRACTS = new Set([CONTRACT_CLAUDE_ON_PATH, CONTRACT_STATE_DIRECTORY]);

/**
 * `ccp setup` (issue #35): the second and last command a new user types. Adds
 * {@link SHELL_WIRING_LINE} to the interactive startup file the user's shell actually reads
 * (`shellRcPath`, resolved the same way `ccp doctor`'s Shell wiring Check reads it — see
 * {@link defaultShellRcPath}'s universal, `$SHELL`-keyed detection, issue #40), then runs the
 * exact same Checks `ccp doctor` exposes
 * ({@link runDoctorChecks}) so problems surface here, once, rather than later as unexplained
 * failures. One implementation, two entry points — this function never reimplements a Check.
 *
 * `--dry-run` previews the line-writing step only — the machine's state is what it already was,
 * so there is nothing to verify and no Checks run. It prints exactly what would be added (or that
 * there's nothing to add, when the line is already present) and nothing else.
 *
 * Writing the line always happens first, unconditionally, even when a Check that follows turns
 * out to fail Setup: the write is independent of whether `claude` is on `PATH` or the state
 * directory is writable, and the shell wiring line itself is exactly as useful once `claude` is
 * later fixed. Only {@link SETUP_FATAL_CONTRACTS}'s two Contracts fail Setup's own exit code —
 * every other Check's finding is still printed, per issue #35's acceptance criteria that a
 * merely-incomplete machine still ends up wired correctly.
 *
 * Ends by naming the next command to run, unconditionally, per this ticket's own acceptance
 * criteria — success points at `ccp add`; a fatal failure points back at re-running `ccp setup`
 * once the reported problem (a missing `claude`, an unwritable state directory) is fixed, rather
 * than leaving a failed run silent about what to do next.
 */
async function runSetup(
  args: string[],
  deps: {
    env: NodeJS.ProcessEnv;
    claudePort: ClaudePort;
    stateDir: string;
    installDir: string;
    installStateFilePath: string;
    legacyStateDir: string;
    shellRcPath: string;
    stdout: (line: string) => void;
    stderr: (line: string) => void;
  },
): Promise<number> {
  if (args.includes("--dry-run")) {
    let present: boolean;
    try {
      present = await shellWiringPresent(deps.shellRcPath);
    } catch (err) {
      return reportError(deps.stderr, err);
    }

    deps.stdout(
      present
        ? `Dry run: ${deps.shellRcPath} already contains the shell wiring line — nothing to add.`
        : `Dry run: would add the following line to ${deps.shellRcPath}:\n  ${SHELL_WIRING_LINE}`,
    );
    return 0;
  }

  let writeResult: { added: boolean };
  try {
    writeResult = await writeShellWiringLine(deps.shellRcPath);
  } catch (err) {
    return reportError(deps.stderr, err);
  }

  const lines: string[] = [
    writeResult.added
      ? `Added the following line to ${deps.shellRcPath}:\n  ${SHELL_WIRING_LINE}`
      : `${deps.shellRcPath} already contains the shell wiring line — nothing to add.`,
  ];

  const reports = await runDoctorChecks({
    env: deps.env,
    claudePort: deps.claudePort,
    stateDir: deps.stateDir,
    installDir: deps.installDir,
    installStateFilePath: deps.installStateFilePath,
    legacyStateDir: deps.legacyStateDir,
    shellRcPath: deps.shellRcPath,
  });
  for (const report of reports) lines.push(`${report.contract}: ${report.finding}`);

  const fatal = reports.some((report) => SETUP_FATAL_CONTRACTS.has(report.contract) && !report.ok);
  lines.push(
    fatal
      ? "Next: fix the problem reported above, then re-run 'ccp setup'."
      : "Next: run 'ccp add <alias>' to create your first Profile.",
  );

  deps.stdout(lines.join("\n"));
  return fatal ? 1 : 0;
}

/**
 * `ccp teardown`: Setup's inverse (issue #35). Removes only {@link SHELL_WIRING_LINE} from the
 * startup file Setup added it to — leaving every other line in the file untouched, and never
 * touching Profiles, the state directory, or anything else. Safe to run when Setup was never run
 * at all: {@link removeShellWiringLine} reports `removed: false` rather than throwing when
 * there's no line to remove.
 *
 * Always reports what it deliberately left behind — the state directory and the existing
 * per-Profile removal command — so the non-destructive choice this makes is visible rather than
 * silent (this ticket's own acceptance criteria), regardless of whether there was a line to
 * remove this time.
 */
async function runTeardown(deps: {
  shellRcPath: string;
  stateDir: string;
  stdout: (line: string) => void;
  stderr: (line: string) => void;
}): Promise<number> {
  let result: { removed: boolean };
  try {
    result = await removeShellWiringLine(deps.shellRcPath);
  } catch (err) {
    return reportError(deps.stderr, err);
  }

  const lines = [
    result.removed
      ? `Removed the shell wiring line from ${deps.shellRcPath}.`
      : `${deps.shellRcPath} had no shell wiring line to remove — nothing to do.`,
    `Left behind on purpose: your Profiles, still under ${deps.stateDir}. Remove one yourself with 'ccp rm <alias> --yes'.`,
  ];

  deps.stdout(lines.join("\n"));
  return 0;
}

/**
 * `ccp doctor` (ticket #33, issue #34): runs every Check — including the identity Check, the only
 * one that spawns a process per Profile (ADR-0010) — and reports each Contract by name alongside
 * what it found (CONTEXT.md's Check). Reports only: like every Check in this project, it never
 * repairs anything — that stays with `ccp sync`.
 *
 * The one deliberate exception to "never writes anything to disk" is this function itself, not
 * {@link runDoctorChecks} (still read-only, still asserted directly by its own tests): once every
 * Check has run, if every single one of them reports `ok` — nothing found on the machine that
 * indicates a Contract broke, isolation included — it records the Claude Code version this run
 * saw as the version its Checks last *passed* against (ADR-0010's "honest replacement for a
 * matrix") via {@link recordVerifiedVersion}. A run that finds even one real problem never
 * overwrites that record — it falls back to whatever was last actually recorded clean, or to
 * "never recorded" if nothing has been — so "Verified against" always names a version this
 * machine actually passed its Checks against, never merely the version it happened to be running
 * during a broken run.
 */
async function runDoctor(deps: {
  env: NodeJS.ProcessEnv;
  claudePort: ClaudePort;
  stateDir: string;
  installDir: string;
  installStateFilePath: string;
  legacyStateDir: string;
  shellRcPath: string;
  stdout: (line: string) => void;
  stderr: (line: string) => void;
}): Promise<number> {
  const reports = await runDoctorChecks(deps);
  const allChecksClean = reports.every((report) => report.ok);

  const versionResolution = await resolveClaudeVersion(deps.claudePort);
  let verifiedVersion: string | null;
  if (versionResolution.ok && allChecksClean) {
    await recordVerifiedVersion(deps.stateDir, versionResolution.version);
    verifiedVersion = versionResolution.version;
  } else {
    verifiedVersion = await loadVerifiedVersion(deps.stateDir);
  }

  const lines = reports.map((report) => `${report.contract}: ${report.finding}`);
  lines.push(`Verified against: ${verifiedVersion ?? "no version has ever been recorded on this machine"}`);

  deps.stdout(lines.join("\n"));
  return 0;
}
