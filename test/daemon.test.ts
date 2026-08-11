import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ProcessDaemonPort } from "../src/daemon.js";

/**
 * Exercises real OS processes rather than a fake — the scoping behaviour (which process, if any,
 * gets killed) is the entire point of this module, so a fake port would test nothing. Only
 * meaningful on Linux, the one platform {@link ProcessDaemonPort} can actually introspect
 * per-process environment on (see src/daemon.ts); the non-Linux behaviour (rejects rather than
 * silently skipping) is covered by its own `describe` below instead.
 */
describe.skipIf(process.platform !== "linux")("ProcessDaemonPort", () => {
  let configDir: string;
  const spawned: ReturnType<typeof spawn>[] = [];

  afterEach(async () => {
    for (const child of spawned) {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
    spawned.length = 0;
    if (configDir) await rm(configDir, { recursive: true, force: true });
  });

  function spawnScopedTo(dir: string): Promise<ReturnType<typeof spawn>> {
    const child = spawn("sleep", ["30"], { env: { ...process.env, CLAUDE_CONFIG_DIR: dir } });
    spawned.push(child);
    return new Promise((resolve, reject) => {
      child.once("spawn", () => resolve(child));
      child.once("error", reject);
    });
  }

  function waitForExit(child: ReturnType<typeof spawn>, timeoutMs: number): Promise<boolean> {
    return new Promise((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) {
        resolve(true);
        return;
      }
      const timer = setTimeout(() => resolve(false), timeoutMs);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve(true);
      });
    });
  }

  it("terminates a process whose CLAUDE_CONFIG_DIR matches the given configDir", async () => {
    configDir = await mkdtemp(join(tmpdir(), "ccp-daemon-test-"));
    const child = await spawnScopedTo(configDir);

    await new ProcessDaemonPort().stopDaemon(configDir);

    await expect(waitForExit(child, 3000)).resolves.toBe(true);
  });

  it("never touches a process bound to a different configDir", async () => {
    configDir = await mkdtemp(join(tmpdir(), "ccp-daemon-test-"));
    const otherDir = await mkdtemp(join(tmpdir(), "ccp-daemon-other-"));
    try {
      const unrelated = await spawnScopedTo(otherDir);

      await new ProcessDaemonPort().stopDaemon(configDir);

      await expect(waitForExit(unrelated, 300)).resolves.toBe(false);
    } finally {
      await rm(otherDir, { recursive: true, force: true });
    }
  });

  it("never touches a process whose configDir merely has this configDir as a string prefix (e.g. 'work' vs 'work2')", async () => {
    const parent = await mkdtemp(join(tmpdir(), "ccp-daemon-prefix-"));
    configDir = join(parent, "work");
    const siblingDir = join(parent, "work2");
    await mkdir(configDir);
    await mkdir(siblingDir);
    try {
      const sibling = await spawnScopedTo(siblingDir);

      await new ProcessDaemonPort().stopDaemon(configDir);

      await expect(waitForExit(sibling, 300)).resolves.toBe(false);
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  it("resolves without throwing when nothing matches", async () => {
    configDir = await mkdtemp(join(tmpdir(), "ccp-daemon-test-"));

    await expect(new ProcessDaemonPort().stopDaemon(configDir)).resolves.toBeUndefined();
  });
});

describe.skipIf(process.platform === "linux")("ProcessDaemonPort (non-Linux)", () => {
  it("rejects rather than silently skipping, so a best-effort caller has something to warn about", async () => {
    await expect(new ProcessDaemonPort().stopDaemon("/some/config/dir")).rejects.toThrow(/not supported/i);
  });
});
