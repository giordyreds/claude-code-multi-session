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

export interface ClaudeCliPortOptions {
  /** Test seam: replaces the real process invocation. Defaults to a real spawn of `claude`. */
  run?: ProcessRunner;
}

const CLAUDE_COMMAND = "claude";

/**
 * Real {@link ClaudePort}: invokes `claude auth status --json`, the one documented
 * machine-readable identity shape Claude Code offers, and parses it into an {@link AuthStatus}.
 * Never reads Claude Code's own state file directly — see ADR-0005.
 */
export class ClaudeCliPort implements ClaudePort {
  private readonly runProcess: ProcessRunner;

  constructor(options: ClaudeCliPortOptions = {}) {
    this.runProcess = options.run ?? runProcess;
  }

  async authStatus(configDir?: string): Promise<AuthStatus> {
    // Left untouched (deferring to the ambient environment) when `configDir` is omitted, rather
    // than deleted — an unbound invocation of this tool never has it set in the first place, so
    // there is nothing to clear, and clearing it would break a caller that legitimately wants the
    // ambient value honored (e.g. this same process already running under a bound shell).
    const env: NodeJS.ProcessEnv = { ...process.env };
    if (configDir !== undefined) {
      env.CLAUDE_CONFIG_DIR = configDir;
    }

    const result = await this.runProcess(CLAUDE_COMMAND, ["auth", "status", "--json"], { env });

    // Verified by probe (ADR-0005): `claude auth status` exits 1 for a perfectly normal
    // logged-out Profile, so success is judged by output shape alone, never by exit code.
    return toAuthStatus(result);
  }
}

function toAuthStatus(result: ProcessResult): AuthStatus {
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    throw new Error(
      `'${CLAUDE_COMMAND} auth status --json' produced unparseable output: ${summarize(result)}`,
    );
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed) || !("loggedIn" in parsed)) {
    throw new Error(
      `'${CLAUDE_COMMAND} auth status --json' produced unexpected output: ${JSON.stringify(parsed)}`,
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
