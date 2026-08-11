import { spawn } from "node:child_process";

/** Outcome of running a command to completion. */
export interface ProcessResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

/**
 * Runs a command to completion. Injectable so tests exercising {@link ClaudeCliPort} never spawn
 * the real `claude` binary.
 */
export type ProcessRunner = (
  command: string,
  args: string[],
  options: { env: NodeJS.ProcessEnv },
) => Promise<ProcessResult>;

/** Outcome of an interactive command — no captured output, since it owns the terminal. */
export interface InteractiveProcessResult {
  exitCode: number | null;
}

/**
 * Runs a command with the terminal handed to it directly (stdio inherited), for flows like
 * `claude auth login` that prompt interactively and open a browser. Injectable so tests never
 * spawn the real `claude` binary.
 */
export type InteractiveProcessRunner = (
  command: string,
  args: string[],
  options: { env: NodeJS.ProcessEnv },
) => Promise<InteractiveProcessResult>;

/** The (Account, Organization) identity `claude` reports for a Profile — see CONTEXT.md. */
export interface AuthStatus {
  loggedIn: boolean;
  /** The Account's email, present only when `loggedIn`. */
  email?: string;
  /** The Organization's display name, present only when `loggedIn`. */
  orgName?: string;
}

/**
 * The single port every invocation of the `claude` executable goes through — see ADR-0005.
 * Real callers use {@link ClaudeCliPort}; tests fake this interface directly.
 */
export interface ClaudePort {
  /**
   * Resolves the identity `claude` reports for the Profile rooted at `configDir`, or the Default
   * install's identity when `configDir` is omitted.
   */
  authStatus(configDir?: string): Promise<AuthStatus>;

  /**
   * Triggers Anthropic's own interactive login flow (it opens a browser) for the Profile rooted
   * at `configDir`, or the Default install when omitted. Resolves once the flow exits
   * successfully; rejects otherwise. Delegates the entire flow — including whatever credential
   * material it stores — to `claude` itself; this project never reads, writes, or stores any of
   * it (ADR-0001).
   */
  login(configDir?: string): Promise<void>;

  /**
   * Resolves the version string `claude --version` reports. Not scoped to any Profile — unlike
   * {@link authStatus}/{@link login}, Claude Code's own version doesn't depend on which
   * `CLAUDE_CONFIG_DIR` is in effect — so this takes no `configDir` parameter.
   *
   * `ccp doctor`'s Claude Code version Check (ticket #33) reads it through this method rather
   * than spawning `claude` directly, per issue #28: one port every invocation of the `claude`
   * executable already goes through, never a second one added just for this.
   */
  version(): Promise<string>;
}

async function runProcess(command: string, args: string[], options: { env: NodeJS.ProcessEnv }): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env: options.env });
    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });

    child.on("error", (err) => {
      reject(err);
    });

    child.on("close", (exitCode) => {
      resolve({ stdout, stderr, exitCode });
    });
  });
}

async function runInteractiveProcess(
  command: string,
  args: string[],
  options: { env: NodeJS.ProcessEnv },
): Promise<InteractiveProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env: options.env, stdio: "inherit" });

    child.on("error", (err) => {
      reject(err);
    });

    child.on("close", (exitCode) => {
      resolve({ exitCode });
    });
  });
}

export interface ClaudeCliPortOptions {
  /** Test seam: replaces the real process invocation. Defaults to a real spawn of `claude`. */
  run?: ProcessRunner;
  /** Test seam: replaces the real interactive process invocation used by {@link login}. */
  runInteractive?: InteractiveProcessRunner;
}

const CLAUDE_COMMAND = "claude";

/**
 * Real {@link ClaudePort}: invokes `claude auth status --json`, the one documented
 * machine-readable identity shape Claude Code offers, and parses it into an {@link AuthStatus}.
 * Never reads Claude Code's own state file directly — see ADR-0005.
 */
export class ClaudeCliPort implements ClaudePort {
  private readonly runProcess: ProcessRunner;
  private readonly runInteractiveProcess: InteractiveProcessRunner;

  constructor(options: ClaudeCliPortOptions = {}) {
    this.runProcess = options.run ?? runProcess;
    this.runInteractiveProcess = options.runInteractive ?? runInteractiveProcess;
  }

  async authStatus(configDir?: string): Promise<AuthStatus> {
    const env = withConfigDir(configDir);
    const result = await this.runProcess(CLAUDE_COMMAND, ["auth", "status", "--json"], { env });

    // Verified by probe (ADR-0005): `claude auth status` exits 1 for a perfectly normal
    // logged-out Profile, so success is judged by output shape alone, never by exit code.
    return toAuthStatus(result);
  }

  async login(configDir?: string): Promise<void> {
    const env = withConfigDir(configDir);
    const { exitCode } = await this.runInteractiveProcess(CLAUDE_COMMAND, ["auth", "login"], { env });

    if (exitCode !== 0) {
      throw new Error(`'${CLAUDE_COMMAND} auth login' exited with code ${exitCode ?? "null"}.`);
    }
  }

  async version(): Promise<string> {
    const result = await this.runProcess(CLAUDE_COMMAND, ["--version"], { env: process.env });

    // No `--json` shape exists for this (unlike `auth status`), so there is nothing to parse —
    // only whitespace to trim. Judged by output shape, same as `authStatus`: a real failure to
    // spawn already rejects via `runProcess`'s own `error` handling, not resolves here.
    const version = result.stdout.trim();
    if (version.length === 0) {
      throw new Error(`'${CLAUDE_COMMAND} --version' produced no output: ${summarize(result)}`);
    }
    return version;
  }
}

/**
 * Left untouched (deferring to the ambient environment) when `configDir` is omitted, rather than
 * deleted — an unbound invocation of this tool never has it set in the first place, so there is
 * nothing to clear, and clearing it would break a caller that legitimately wants the ambient
 * value honored (e.g. this same process already running under a bound shell).
 */
function withConfigDir(configDir?: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (configDir !== undefined) {
    env.CLAUDE_CONFIG_DIR = configDir;
  }
  return env;
}

/**
 * Named in every error thrown below when `claude auth status --json`'s output no longer parses
 * the way this project assumes (CONTEXT.md's Contract): Anthropic never documented this shape and
 * owes us nothing (ADR-0010), so the most likely explanation for a sudden parse failure is that
 * Claude Code itself changed underneath this tool, not that this one invocation glitched. Points
 * at `ccp doctor` rather than leaving a bare parse error to guess at, since that's the command
 * built to say what's actually still true on this machine (issue #34).
 */
const CONTRACT_CHANGED_HINT =
  "Claude Code may have changed how it reports identity. Run 'ccp doctor' to see what still holds on this machine.";

function toAuthStatus(result: ProcessResult): AuthStatus {
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    throw new Error(
      `'${CLAUDE_COMMAND} auth status --json' produced unparseable output: ${summarize(result)}. ${CONTRACT_CHANGED_HINT}`,
    );
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed) || !("loggedIn" in parsed)) {
    throw new Error(
      `'${CLAUDE_COMMAND} auth status --json' produced unexpected output: ${JSON.stringify(parsed)}. ${CONTRACT_CHANGED_HINT}`,
    );
  }

  const record = parsed as Record<string, unknown>;
  return {
    loggedIn: Boolean(record.loggedIn),
    email: typeof record.email === "string" ? record.email : undefined,
    orgName: typeof record.orgName === "string" ? record.orgName : undefined,
  };
}

/** Renders a failed {@link ProcessResult} for an error message. Named to avoid shadowing vitest's `describe`, which every test file in this project imports. */
function summarize(result: ProcessResult): string {
  const parts = [`stdout: ${JSON.stringify(result.stdout)}`];
  if (result.stderr) parts.push(`stderr: ${JSON.stringify(result.stderr)}`);
  return parts.join(", ");
}
