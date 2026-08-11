import { readdir, readFile } from "node:fs/promises";
import { isErrnoException } from "./fs-utils.js";

/**
 * Best-effort cleanup of a Profile's background daemon (ADR-0001: "Claude Code runs a
 * per-configuration daemon, so N Profiles likely means N daemons. Removing a Profile should
 * attempt to clean its daemon up."). Never a hard requirement of removal — see `ccp rm`'s
 * acceptance criteria — so callers decide how a failure here is reported, if at all.
 */
export interface DaemonPort {
  /** Terminates whatever OS process(es) are scoped to `configDir`, if any are found. */
  stopDaemon(configDir: string): Promise<void>;
}

/**
 * Scopes a process to a Profile the same way Binding does (ADR-0005): by the `CLAUDE_CONFIG_DIR`
 * it was launched with. Reading another process's environment is Linux-only (`/proc/<pid>/environ`);
 * there's no equivalent without extra privileges on macOS, so elsewhere this throws rather than
 * silently doing nothing — an honest "didn't look" the caller can surface, rather than a
 * best-effort that quietly degrades to no effort at all.
 */
export class ProcessDaemonPort implements DaemonPort {
  async stopDaemon(configDir: string): Promise<void> {
    if (process.platform !== "linux") {
      throw new Error(`daemon cleanup is not supported on ${process.platform} yet`);
    }

    const needle = `CLAUDE_CONFIG_DIR=${configDir}`;
    for (const pid of await listPids()) {
      if (pid === process.pid) continue;

      const environ = await readEnviron(pid);
      // NUL-delimited KEY=VALUE entries — split before comparing, never substring-match the raw
      // blob, or a configDir that's a string prefix of a sibling Profile's (e.g. "work" vs
      // "work2") would match the wrong process and kill its daemon too.
      if (environ?.split("\0").includes(needle)) {
        try {
          process.kill(pid, "SIGTERM");
        } catch (err) {
          // The process may have already exited between listing and here — an ordinary race,
          // not a failure worth surfacing for a best-effort cleanup.
          if (!isErrnoException(err) || err.code !== "ESRCH") throw err;
        }
      }
    }
  }
}

async function listPids(): Promise<number[]> {
  const entries = await readdir("/proc");
  return entries.filter((name) => /^\d+$/.test(name)).map(Number);
}

/** `null` when the process has already exited or its environment can't be read (e.g. owned by
 * another user) — either way, nothing this Profile's `configDir` could have started. */
async function readEnviron(pid: number): Promise<string | null> {
  try {
    return await readFile(`/proc/${pid}/environ`, "utf8");
  } catch {
    return null;
  }
}
