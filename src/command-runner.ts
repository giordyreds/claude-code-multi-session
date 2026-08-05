import { spawn } from "node:child_process";

/** Outcome of running a command with the terminal handed to it directly — no captured output,
 * since the whole point is that it owns the terminal (see ticket #11: `ccp run`). */
export interface CommandRunResult {
  exitCode: number | null;
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

    child.on("close", (exitCode) => {
      resolve({ exitCode });
    });
  });
};
