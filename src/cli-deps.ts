import type { ClaudePort } from "./claude-port.js";
import type { CommandRunner } from "./command-runner.js";
import type { DaemonPort } from "./daemon.js";
import type { OnboardingSeeder } from "./onboarding.js";
import type { Picker } from "./picker.js";

/**
 * Every subcommand's resolved dependencies, after `runCli` has applied defaults — the one
 * dependency interface every command takes (issue #53). Adding a dependency means editing this
 * interface (1 field) and `runCli`'s default-resolution block (1 line) — never a command's own
 * signature, since every command already takes the whole thing.
 */
export interface CliDeps {
  /** The shell environment to resolve Binding from. Defaults to `process.env`. */
  env: NodeJS.ProcessEnv;
  stdout: (line: string) => void;
  stderr: (line: string) => void;
  /**
   * Test seam: replaces every invocation of the real `claude` executable (see ADR-0005) so
   * `whoami` — and every future identity-resolving command — is testable without spawning it.
   * Defaults to a real {@link ClaudeCliPort}.
   */
  claudePort: ClaudePort;
  /** Test seam: the tool's own state directory, holding the Profile registry and every managed
   * Profile's isolated config directory. Defaults to `~/.ccp`, or `$CCP_HOME` if set. */
  stateDir: string;
  /** Test seam: the Default install's configuration directory — the source of the Rig shared
   * into every newly added Profile (ADR-0007). Defaults to `~/.claude`. */
  installDir: string;
  /** Test seam: the Default install's own `.claude.json` — a *file* path, and a sibling of
   * `installDir` rather than something inside it (see {@link defaultInstallStateFilePath}).
   * Source for `ccp login`'s onboarding pre-seed (issue #27). Defaults to `~/.claude.json`. */
  installStateFilePath: string;
  /** Test seam: replaces `ccp rm`'s best-effort daemon cleanup (ADR-0001) so tests never depend
   * on real OS processes. Defaults to a real {@link ProcessDaemonPort}. */
  daemonPort: DaemonPort;
  /**
   * Test seam: replaces the interactive picker `ccp use` shows when invoked with no Alias (see
   * ticket #9). Defaults to a real {@link TtyPicker} reading `process.stdin`, drawing on
   * `process.stderr` — never stdout, per ADR-0004.
   */
  picker: Picker;
  /**
   * Test seam: replaces the real spawn behind `ccp run <alias> -- <command>` (ticket #11), so
   * tests never spawn a real child process. Defaults to a real {@link CommandRunner} that
   * inherits stdio.
   */
  commandRunner: CommandRunner;
  /**
   * Test seam: replaces `ccp login`'s best-effort onboarding pre-seed attempt (issue #27), so
   * tests can exercise its "warn, never fail Login" behaviour without depending on real
   * filesystem permission errors. Defaults to the real {@link seedOnboardingState}.
   */
  onboardingSeeder: OnboardingSeeder;
  /** Test seam: where a state directory under the pre-rename name (issue #31) would live, for
   * `ccp doctor`'s Legacy state directory Check. Defaults to `~/.ccacct`. */
  legacyStateDir: string;
  /** Test seam: the shell startup file `ccp doctor`'s Shell wiring Check reads, and `ccp setup`/
   * `ccp teardown` write to. Defaults to {@link defaultShellRcPath}'s detection from `$SHELL`. */
  shellRcPath: string;
  /** Test seam: the platform this invocation runs on, for the Windows hard guard (issue #40).
   * Defaults to `process.platform`. */
  platform: string;
}

/**
 * `runCli`'s own parameter shape: every {@link CliDeps} field, optional, since `runCli`
 * resolves whichever ones are omitted to their real-world default before any command runs.
 * There is no test-only seam left over that doesn't already belong in `CliDeps` — every one of
 * these fields is a dependency some command actually takes.
 */
export type RunCliOptions = Partial<CliDeps>;

/** One subcommand's implementation: `argv` with the command word itself already stripped, plus
 * the full resolved {@link CliDeps} — the uniform shape every entry in a command module's
 * `Record<string, Command>` map takes. */
export type Command = (args: string[], deps: CliDeps) => Promise<number>;
