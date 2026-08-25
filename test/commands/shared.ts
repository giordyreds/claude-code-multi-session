import type { AuthStatus, ClaudePort } from "../../src/claude-port.js";

/** Fixtures shared by more than one `test/commands/*.test.ts` group (ADR-0015) — the
 * `test/cli.test.ts` counterpart to `src/commands/shared.ts`. A fixture used by only one group's
 * tests lives in that group's own file instead, mirroring the single-caller rule ADR-0015 applies
 * source-side. */

/** Captures every line written to stdout/stderr, in order, for assertion. */
export function captureLines(): { stdout: string[]; stderr: string[]; stdoutFn: (line: string) => void; stderrFn: (line: string) => void } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return { stdout, stderr, stdoutFn: (line) => stdout.push(line), stderrFn: (line) => stderr.push(line) };
}

/**
 * A fake ClaudePort that resolves `authStatus` to a fixed AuthStatus and records what it was
 * asked. `login` succeeds by default (or rejects with `loginError`, if given) and records its own
 * calls separately, so tests can assert login was (or wasn't) triggered independently of whoami.
 */
export function fakeClaudePort(
  status: AuthStatus,
  options?: { loginError?: string; version?: string },
): ClaudePort & { calls: Array<string | undefined>; loginCalls: Array<string | undefined> } {
  const calls: Array<string | undefined> = [];
  const loginCalls: Array<string | undefined> = [];
  return {
    calls,
    loginCalls,
    async login(configDir?: string) {
      loginCalls.push(configDir);
      if (options?.loginError) throw new Error(options.loginError);
    },
    async authStatus(configDir?: string) {
      calls.push(configDir);
      return status;
    },
    async version() {
      return options?.version ?? "1.0.0 (Claude Code)";
    },
  };
}

export function throwingClaudePort(message: string): ClaudePort {
  return {
    async login() {},
    async authStatus() {
      throw new Error(message);
    },
    async version() {
      throw new Error(message);
    },
  };
}
