import { homedir } from "node:os";
import { basename, join, resolve as resolvePath } from "node:path";
import { ClaudeCliPort } from "./claude-port.js";
import type { CliDeps, Command, RunCliOptions } from "./cli-deps.js";
import { runCommand } from "./command-runner.js";
import { IDENTITY_COMMANDS } from "./commands/identity.js";
import { MACHINE_COMMANDS } from "./commands/machine.js";
import { PROFILE_COMMANDS } from "./commands/profile.js";
import { SHELL_COMMANDS } from "./commands/shell.js";
import { ProcessDaemonPort } from "./daemon.js";
import { LEGACY_STATE_DIR_NAME } from "./doctor.js";
import { reportError } from "./fs-utils.js";
import { seedOnboardingState } from "./onboarding.js";
import { TtyPicker } from "./picker.js";
import { packageVersion } from "./version.js";

export type { RunCliOptions } from "./cli-deps.js";

const USAGE =
  "Usage: ccp <command>\n\nCommands:\n  setup              Wire the `ccp` shell function into your shell's startup file and verify the\n                     machine can run the tool — the second command after installing\n  whoami             Report the bound Profile's identity\n  add <alias>        Create a new Profile\n  ls                 List every Profile\n  login <alias>      Authenticate a Profile and record its resulting identity\n  use [alias]        Bind the current shell to a Profile (via the `ccp` shell function); with no\n                     Alias, shows an interactive picker\n  shell-init         Emit the `ccp` shell function, for a shell startup file to `eval`\n  run <alias>        Run a command under a Profile's identity, no shell function required —\n                     usage: ccp run <alias> -- <command>\n  reconcile <alias>  Accept a drifted Profile's observed identity as its new Expected identity\n  sync               Re-render every Profile's settings and repair its Rig sharing\n  doctor             Run every Check and report each Contract by name alongside what it found —\n                     reports only, never repairs (see `ccp sync`)\n  rm <alias> --yes   Permanently remove a Profile, its configuration and its isolated history\n  teardown           Undo Setup: remove the shell wiring line it added — never touches Profiles\n\nFlags:\n  --version          Print ccp's own version\n  --dry-run          With `setup`, print the line it would add instead of writing it\n  --help             Print this usage text";

/** The Default install's live settings file — the base every Profile's settings render from
 * (ADR-0002) — and the name the rendered result takes in each Profile's own config directory
 * too, since both are just "the settings file" in their respective directories. */
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

/** Dispatch table for `runCli`'s command switch, composed from each `commands/*.ts` module's own
 * map (ADR-0015) — data rather than a hand-maintained `switch`, so the unknown-command path falls
 * out of a lookup miss instead of needing its own upkeep alongside this table, and adding a
 * command inside an existing group is a one-file change instead of two. */
const COMMANDS: Record<string, Command> = {
  ...IDENTITY_COMMANDS,
  ...PROFILE_COMMANDS,
  ...SHELL_COMMANDS,
  ...MACHINE_COMMANDS,
};

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

  const deps: CliDeps = {
    env,
    stdout,
    stderr,
    claudePort,
    stateDir,
    installDir,
    installStateFilePath,
    daemonPort,
    picker,
    commandRunner,
    onboardingSeeder,
    legacyStateDir,
    shellRcPath,
    platform,
  };

  const command = COMMANDS[argv[0]!];
  if (!command) {
    stderr(`Unknown command '${argv[0]}'. ${USAGE}`);
    return 1;
  }
  return command(argv.slice(1), deps);
}
