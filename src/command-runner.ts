import { spawn } from "node:child_process";
import { constants } from "node:os";

/** Outcome of running a command with the terminal handed to it directly — no captured output,
 * since the whole point is that it owns the terminal (see ticket #11: `ccp run`). Node reports
 * `exitCode: null` when the command was killed by a signal instead of exiting normally; `signal`
 * carries which one, so that case isn't silently indistinguishable from a normal exit. */
export interface CommandRunResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
}

/**
 * Runs an arbitrary command with stdio inherited from this process, so its stdout, stderr, and
 * exit status pass through untouched. Injectable so tests never spawn a real child process.
 */
export type CommandRunner = (
  command: string,
  args: string[],
  options: { env: NodeJS.ProcessEnv },
) => Promise<CommandRunResult>;

/**
 * Real {@link CommandRunner} behind `ccp run <alias> -- <command>` (ticket #11): one-shot
 * execution under a Profile's identity for scripts, jobs, and other non-interactive callers that
 * never sourced the `ccp` shell function. Inherits stdio rather than capturing it — this runs a
 * caller-chosen command, not `claude` itself, so there is no fixed output shape to parse and
 * nothing here should buffer or reformat what it prints.
 */
export const runCommand: CommandRunner = (command, args, options) => {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env: options.env, stdio: "inherit" });

    child.on("error", (err) => {
      reject(err);
    });

    child.on("close", (exitCode, signal) => {
      resolve({ exitCode, signal });
    });
  });
};

/**
 * Resolves a {@link CommandRunResult} to the numeric exit code `ccp run` itself should exit with
 * (`process.exitCode` must be a number — there's no way to hand back "killed by a signal" as-is).
 * A command that was killed by a signal maps to the same `128 + signal number` convention `sh`
 * and `bash` use, rather than collapsing to a flat `1` indistinguishable from the command
 * legitimately exiting `1` on its own — the "exit status ... pass through untouched" acceptance
 * criterion (ticket #11) extends to this case too.
 */
export function resolveExitCode(result: CommandRunResult): number {
  if (result.exitCode !== null) return result.exitCode;
  const signalNumber = result.signal ? constants.signals[result.signal] : undefined;
  return signalNumber !== undefined ? 128 + signalNumber : 1;
}
