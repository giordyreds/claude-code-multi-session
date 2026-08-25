import { mkdir, mkdtemp, readFile, readlink, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../../src/cli.js";
import type { DaemonPort } from "../../src/daemon.js";
import { DEFAULT_INSTALL_ALIAS, loadRegistry } from "../../src/registry.js";
import { captureLines } from "./shared.js";

/** A fake DaemonPort that records every `configDir` it was asked to stop, and optionally rejects
 * (to exercise `ccp rm`'s "best-effort — never fails removal" acceptance criterion). Used only by
 * `runCli rm` below, so it lives here rather than in `./shared.js` (ADR-0015's single-caller rule). */
function fakeDaemonPort(options?: { error?: string }): DaemonPort & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async stopDaemon(configDir: string) {
      calls.push(configDir);
      if (options?.error) throw new Error(options.error);
    },
  };
}

describe("runCli add", () => {
  let stateDir: string;
  let installDir: string;

  beforeEach(async () => {
    stateDir = await mkdtemp(join(tmpdir(), "ccp-cli-add-test-"));
    installDir = await mkdtemp(join(tmpdir(), "ccp-cli-add-install-"));
  });

  afterEach(async () => {
    await rm(stateDir, { recursive: true, force: true });
    await rm(installDir, { recursive: true, force: true });
  });

  it("creates a Profile and registers its Alias", async () => {
    const { stdout, stderr, stdoutFn, stderrFn } = captureLines();

    const code = await runCli(["add", "work"], { stateDir, installDir, stdout: stdoutFn, stderr: stderrFn });

    expect(code).toBe(0);
    expect(stderr).toEqual([]);
    expect(stdout.join("\n")).toMatch(/work/);

    const registry = await loadRegistry(stateDir);
    expect(registry.profiles.work).toBeDefined();
    expect(registry.profiles.work?.expectedIdentity).toBeNull();
  });

  it("shares the Rig from the Default install into the new Profile, without duplicating it", async () => {
    await writeFile(join(installDir, "CLAUDE.md"), "# Instructions", "utf8");

    const { stdout, stderr, stdoutFn, stderrFn } = captureLines();
    const code = await runCli(["add", "work"], { stateDir, installDir, stdout: stdoutFn, stderr: stderrFn });

    expect(code).toBe(0);
    expect(stderr).toEqual([]);

    const registry = await loadRegistry(stateDir);
    const configDir = registry.profiles.work!.configDir;
    expect(await readlink(join(configDir, "CLAUDE.md"))).toBe(join(installDir, "CLAUDE.md"));
  });

  it("rejects a duplicate Alias with an actionable message on stderr and changes nothing", async () => {
    await runCli(["add", "work"], { stateDir, installDir, stdout: () => {}, stderr: () => {} });
    const registryBefore = await loadRegistry(stateDir);

    const { stdout, stderr, stdoutFn, stderrFn } = captureLines();
    const code = await runCli(["add", "work"], { stateDir, installDir, stdout: stdoutFn, stderr: stderrFn });

    expect(code).toBe(1);
    expect(stdout).toEqual([]);
    expect(stderr.join("\n")).toMatch(/work/i);

    const registryAfter = await loadRegistry(stateDir);
    expect(registryAfter).toEqual(registryBefore);
  });

  it("requires an alias argument", async () => {
    const { stdout, stderr, stdoutFn, stderrFn } = captureLines();

    const code = await runCli(["add"], { stateDir, installDir, stdout: stdoutFn, stderr: stderrFn });

    expect(code).toBe(1);
    expect(stdout).toEqual([]);
    expect(stderr.join("\n")).toMatch(/alias/i);
  });

  it("rejects '(default)' as an Alias since it's reserved for the Default install", async () => {
    const { stdout, stderr, stdoutFn, stderrFn } = captureLines();

    const code = await runCli(["add", "(default)"], { stateDir, installDir, stdout: stdoutFn, stderr: stderrFn });

    expect(code).toBe(1);
    expect(stdout).toEqual([]);
    expect(stderr.join("\n")).toMatch(/reserved/i);
  });
});

describe("runCli sync", () => {
  let stateDir: string;
  let installDir: string;

  beforeEach(async () => {
    stateDir = await mkdtemp(join(tmpdir(), "ccp-cli-sync-test-"));
    installDir = await mkdtemp(join(tmpdir(), "ccp-cli-sync-install-"));
  });

  afterEach(async () => {
    await rm(stateDir, { recursive: true, force: true });
    await rm(installDir, { recursive: true, force: true });
  });

  it("reports nothing to sync when no Profile is registered", async () => {
    const { stdout, stderr, stdoutFn, stderrFn } = captureLines();

    const code = await runCli(["sync"], { stateDir, installDir, stdout: stdoutFn, stderr: stderrFn });

    expect(code).toBe(0);
    expect(stderr).toEqual([]);
    expect(stdout.join("\n")).toMatch(/no profiles/i);
  });

  it("renders settings for every Profile from the current base and overrides", async () => {
    await writeFile(join(installDir, "settings.json"), JSON.stringify({ model: "sonnet" }), "utf8");
    await runCli(["add", "work"], { stateDir, installDir, stdout: () => {}, stderr: () => {} });
    const { configDir } = (await loadRegistry(stateDir)).profiles.work!;
    await writeFile(join(configDir, "settings.override.json"), JSON.stringify({ model: "opus" }), "utf8");

    const { stdout, stderr, stdoutFn, stderrFn } = captureLines();
    const code = await runCli(["sync"], { stateDir, installDir, stdout: stdoutFn, stderr: stderrFn });

    expect(code).toBe(0);
    expect(stderr).toEqual([]);
    expect(stdout.join("\n")).toMatch(/work:.*settings re-rendered/i);

    const rendered = JSON.parse(await readFile(join(configDir, "settings.json"), "utf8"));
    expect(rendered.model).toBe("opus");
  });

  it("repairs a broken Rig symlink and reports it", async () => {
    await writeFile(join(installDir, "CLAUDE.md"), "# Instructions", "utf8");
    await runCli(["add", "work"], { stateDir, installDir, stdout: () => {}, stderr: () => {} });
    const { configDir } = (await loadRegistry(stateDir)).profiles.work!;

    // Simulate broken Rig sharing: point the symlink somewhere stale.
    await rm(join(configDir, "CLAUDE.md"));
    await writeFile(join(installDir, "stale.md"), "old", "utf8");
    await symlink(join(installDir, "stale.md"), join(configDir, "CLAUDE.md"));

    const { stdout, stderr, stdoutFn, stderrFn } = captureLines();
    const code = await runCli(["sync"], { stateDir, installDir, stdout: stdoutFn, stderr: stderrFn });

    expect(code).toBe(0);
    expect(stderr).toEqual([]);
    expect(stdout.join("\n")).toMatch(/work:.*Rig repaired \(CLAUDE\.md\)/i);
    expect(await readlink(join(configDir, "CLAUDE.md"))).toBe(join(installDir, "CLAUDE.md"));
  });

  it("reports no changes for a Profile that's already fully in sync", async () => {
    await writeFile(join(installDir, "settings.json"), JSON.stringify({ model: "sonnet" }), "utf8");
    await runCli(["add", "work"], { stateDir, installDir, stdout: () => {}, stderr: () => {} });

    await runCli(["sync"], { stateDir, installDir, stdout: () => {}, stderr: () => {} });

    const { stdout, stderr, stdoutFn, stderrFn } = captureLines();
    const code = await runCli(["sync"], { stateDir, installDir, stdout: stdoutFn, stderr: stderrFn });

    expect(code).toBe(0);
    expect(stderr).toEqual([]);
    expect(stdout).toEqual(["work: no changes"]);
  });

  it("refuses to clobber a hand-edited settings file, reporting the Profile skipped rather than crashing the whole run", async () => {
    await writeFile(join(installDir, "settings.json"), JSON.stringify({ model: "sonnet" }), "utf8");
    await runCli(["add", "work"], { stateDir, installDir, stdout: () => {}, stderr: () => {} });
    await runCli(["add", "personal"], { stateDir, installDir, stdout: () => {}, stderr: () => {} });
    await runCli(["sync"], { stateDir, installDir, stdout: () => {}, stderr: () => {} });

    const { configDir } = (await loadRegistry(stateDir)).profiles.work!;
    const onDisk = JSON.parse(await readFile(join(configDir, "settings.json"), "utf8"));
    onDisk.model = "hand-edited";
    const handEdited = JSON.stringify(onDisk);
    await writeFile(join(configDir, "settings.json"), handEdited, "utf8");

    const { stdout, stderr, stdoutFn, stderrFn } = captureLines();
    const code = await runCli(["sync"], { stateDir, installDir, stdout: stdoutFn, stderr: stderrFn });

    expect(code).toBe(1);
    expect(stdout.join("\n")).toMatch(/work: SKIPPED.*hand-edited/i);
    // The other Profile still syncs — one broken Profile doesn't take down the whole run.
    expect(stdout.join("\n")).toMatch(/personal: no changes/i);
    // Never clobbered.
    await expect(readFile(join(configDir, "settings.json"), "utf8")).resolves.toBe(handEdited);
  });

  it("running it twice in a row reports no changes the second time", async () => {
    await writeFile(join(installDir, "settings.json"), JSON.stringify({ model: "sonnet" }), "utf8");
    await mkdir(join(installDir, "skills"));
    await runCli(["add", "work"], { stateDir, installDir, stdout: () => {}, stderr: () => {} });
    await runCli(["add", "personal"], { stateDir, installDir, stdout: () => {}, stderr: () => {} });

    const first = captureLines();
    const firstCode = await runCli(["sync"], { stateDir, installDir, stdout: first.stdoutFn, stderr: first.stderrFn });
    expect(firstCode).toBe(0);

    const second = captureLines();
    const secondCode = await runCli(["sync"], { stateDir, installDir, stdout: second.stdoutFn, stderr: second.stderrFn });

    expect(secondCode).toBe(0);
    expect(second.stderr).toEqual([]);
    expect(second.stdout).toEqual(["personal: no changes\nwork: no changes"]);
  });
});

describe("runCli rm", () => {
  let stateDir: string;
  let installDir: string;

  beforeEach(async () => {
    stateDir = await mkdtemp(join(tmpdir(), "ccp-cli-rm-test-"));
    installDir = await mkdtemp(join(tmpdir(), "ccp-cli-rm-install-"));
  });

  afterEach(async () => {
    await rm(stateDir, { recursive: true, force: true });
    await rm(installDir, { recursive: true, force: true });
  });

  it("requires an alias", async () => {
    const { stdout, stderr, stdoutFn, stderrFn } = captureLines();

    const code = await runCli(["rm"], { stateDir, installDir, stdout: stdoutFn, stderr: stderrFn });

    expect(code).toBe(1);
    expect(stdout).toEqual([]);
    expect(stderr.join("\n")).toMatch(/usage/i);
  });

  it("refuses to remove the Default install", async () => {
    const { stdout, stderr, stdoutFn, stderrFn } = captureLines();

    const code = await runCli(["rm", DEFAULT_INSTALL_ALIAS, "--yes"], { stateDir, installDir, stdout: stdoutFn, stderr: stderrFn });

    expect(code).toBe(1);
    expect(stdout).toEqual([]);
    expect(stderr.join("\n")).toMatch(/default/i);
  });

  it("fails for an unknown Alias", async () => {
    const { stdout, stderr, stdoutFn, stderrFn } = captureLines();

    const code = await runCli(["rm", "ghost", "--yes"], { stateDir, installDir, stdout: stdoutFn, stderr: stderrFn });

    expect(code).toBe(1);
    expect(stdout).toEqual([]);
    expect(stderr.join("\n")).toMatch(/ghost/i);
  });

  it("requires explicit confirmation stating history will be lost, and changes nothing without it", async () => {
    await runCli(["add", "work"], { stateDir, installDir, stdout: () => {}, stderr: () => {} });
    const { configDir } = (await loadRegistry(stateDir)).profiles.work!;

    const { stdout, stderr, stdoutFn, stderrFn } = captureLines();
    const code = await runCli(["rm", "work"], { stateDir, installDir, stdout: stdoutFn, stderr: stderrFn });

    expect(code).toBe(1);
    expect(stdout).toEqual([]);
    expect(stderr.join("\n")).toMatch(/history/i);

    const registry = await loadRegistry(stateDir);
    expect(registry.profiles.work).toBeDefined();
    await expect(stat(configDir)).resolves.toBeDefined();
  });

  it("removes the Profile, its configuration and its isolated history once confirmed", async () => {
    await runCli(["add", "work"], { stateDir, installDir, stdout: () => {}, stderr: () => {} });
    const { configDir } = (await loadRegistry(stateDir)).profiles.work!;
    const daemonPort = fakeDaemonPort();

    const { stdout, stderr, stdoutFn, stderrFn } = captureLines();
    const code = await runCli(["rm", "work", "--yes"], {
      stateDir,
      installDir,
      stdout: stdoutFn,
      stderr: stderrFn,
      env: {},
      daemonPort,
    });

    expect(code).toBe(0);
    expect(stderr).toEqual([]);
    expect(stdout.join("\n")).toMatch(/work/);

    const registry = await loadRegistry(stateDir);
    expect(registry.profiles.work).toBeUndefined();
    await expect(stat(configDir)).rejects.toThrow();
    expect(daemonPort.calls).toEqual([configDir]);
  });

  it("cleans up the daemon on a best-effort basis: a daemon failure warns but never fails the removal", async () => {
    await runCli(["add", "work"], { stateDir, installDir, stdout: () => {}, stderr: () => {} });
    const daemonPort = fakeDaemonPort({ error: "no permission to signal pid 123" });

    const { stdout, stderr, stdoutFn, stderrFn } = captureLines();
    const code = await runCli(["rm", "work", "--yes"], {
      stateDir,
      installDir,
      stdout: stdoutFn,
      stderr: stderrFn,
      env: {},
      daemonPort,
    });

    expect(code).toBe(0);
    expect(stderr.join("\n")).toMatch(/daemon/i);
    const registry = await loadRegistry(stateDir);
    expect(registry.profiles.work).toBeUndefined();
  });

  it("warns clearly, but does not block, when the current shell is bound to the Profile being removed", async () => {
    await runCli(["add", "work"], { stateDir, installDir, stdout: () => {}, stderr: () => {} });
    const { configDir } = (await loadRegistry(stateDir)).profiles.work!;

    const { stdout, stderr, stdoutFn, stderrFn } = captureLines();
    const code = await runCli(["rm", "work", "--yes"], {
      stateDir,
      installDir,
      stdout: stdoutFn,
      stderr: stderrFn,
      env: { CLAUDE_CONFIG_DIR: configDir },
      daemonPort: fakeDaemonPort(),
    });

    expect(code).toBe(0);
    expect(stderr.join("\n")).toMatch(/bound/i);
    const registry = await loadRegistry(stateDir);
    expect(registry.profiles.work).toBeUndefined();
  });

  it("leaves every other Profile untouched", async () => {
    await runCli(["add", "work"], { stateDir, installDir, stdout: () => {}, stderr: () => {} });
    await runCli(["add", "personal"], { stateDir, installDir, stdout: () => {}, stderr: () => {} });
    const { configDir: personalConfigDir } = (await loadRegistry(stateDir)).profiles.personal!;

    const code = await runCli(["rm", "work", "--yes"], {
      stateDir,
      installDir,
      stdout: () => {},
      stderr: () => {},
      env: {},
      daemonPort: fakeDaemonPort(),
    });

    expect(code).toBe(0);
    const registry = await loadRegistry(stateDir);
    expect(registry.profiles.personal).toBeDefined();
    await expect(stat(personalConfigDir)).resolves.toBeDefined();
  });
});
