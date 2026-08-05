import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli.js";
import type { AuthStatus, ClaudePort } from "../src/claude-port.js";
import { loadRegistry } from "../src/registry.js";

/** Captures every line written to stdout/stderr, in order, for assertion. */
function captureLines(): { stdout: string[]; stderr: string[]; stdoutFn: (line: string) => void; stderrFn: (line: string) => void } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return { stdout, stderr, stdoutFn: (line) => stdout.push(line), stderrFn: (line) => stderr.push(line) };
}

/** A fake ClaudePort that resolves to a fixed AuthStatus and records what it was asked. */
function fakeClaudePort(status: AuthStatus): ClaudePort & { calls: Array<string | undefined> } {
  const calls: Array<string | undefined> = [];
  return {
    calls,
    async authStatus(configDir?: string) {
      calls.push(configDir);
      return status;
    },
  };
}

function throwingClaudePort(message: string): ClaudePort {
  return {
    async authStatus() {
      throw new Error(message);
    },
  };
}

describe("runCli", () => {
  it("prints usage to stdout and exits 0 on a bare invocation", async () => {
    const { stdout, stderr, stdoutFn, stderrFn } = captureLines();

    const code = await runCli([], { stdout: stdoutFn, stderr: stderrFn });

    expect(code).toBe(0);
    expect(stdout.join("\n")).toMatch(/usage/i);
    expect(stderr).toEqual([]);
  });

  it("prints usage to stdout and exits 0 on --help", async () => {
    const { stdout, stdoutFn, stderrFn } = captureLines();

    const code = await runCli(["--help"], { stdout: stdoutFn, stderr: stderrFn });

    expect(code).toBe(0);
    expect(stdout.join("\n")).toMatch(/usage/i);
  });

  it("reports an unknown command to stderr, never stdout, and exits 1", async () => {
    const { stdout, stderr, stdoutFn, stderrFn } = captureLines();

    const code = await runCli(["destroy"], { stdout: stdoutFn, stderr: stderrFn });

    expect(code).toBe(1);
    expect(stdout).toEqual([]);
    expect(stderr.join("\n")).toMatch(/unknown command 'destroy'/i);
  });
});

describe("runCli whoami", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "ccp-cli-test-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("reports '(default)' and the Default install's identity for an unbound shell", async () => {
    const { stdout, stderr, stdoutFn, stderrFn } = captureLines();
    const claudePort = fakeClaudePort({ loggedIn: true, email: "dev@example.com", orgName: "Acme Corp" });

    const code = await runCli(["whoami"], { env: {}, stdout: stdoutFn, stderr: stderrFn, claudePort });

    expect(code).toBe(0);
    expect(stderr).toEqual([]);
    const report = stdout.join("\n");
    expect(report).toMatch(/\(default\)/);
    expect(report).toMatch(/dev@example\.com/);
    expect(report).toMatch(/Acme Corp/);
    // Never a blank identity for an unbound shell — the criterion this test exists to pin down.
    expect(report).not.toMatch(/\(not logged in\)/);
    // Unbound: no directory override, so the port falls through to whichever install is ambient.
    expect(claudePort.calls).toEqual([undefined]);
  });

  it("reports the bound Profile's Alias (its config directory's basename) and resolved identity", async () => {
    const configDir = join(root, "work");
    const { stdout, stderr, stdoutFn, stderrFn } = captureLines();
    const claudePort = fakeClaudePort({ loggedIn: true, email: "work@example.com", orgName: "Work Org" });

    const code = await runCli(["whoami"], {
      env: { CLAUDE_CONFIG_DIR: configDir },
      stdout: stdoutFn,
      stderr: stderrFn,
      claudePort,
    });

    expect(code).toBe(0);
    expect(stderr).toEqual([]);
    const report = stdout.join("\n");
    expect(report).toMatch(/\bwork\b/);
    expect(report).toMatch(/work@example\.com/);
    expect(report).toMatch(/Work Org/);
    // The Profile's own directory is what gets asked about, not the ambient environment.
    expect(claudePort.calls).toEqual([configDir]);
  });

  it("reports '(not logged in)' rather than a blank when the resolved Profile has no stored credentials", async () => {
    const { stdout, stderr, stdoutFn, stderrFn } = captureLines();
    const claudePort = fakeClaudePort({ loggedIn: false });

    const code = await runCli(["whoami"], { env: {}, stdout: stdoutFn, stderr: stderrFn, claudePort });

    expect(code).toBe(0);
    expect(stderr).toEqual([]);
    expect(stdout.join("\n")).toMatch(/\(not logged in\)/);
  });

  it("never mislabels a logged-in Profile as '(not logged in)' just because email/orgName came back missing", async () => {
    // A ClaudePort implementation could report loggedIn: true without email/orgName (the
    // AuthStatus type permits it even though the real `claude auth status --json` always
    // supplies both — see ADR-0005). "(not logged in)" would be an outright false statement
    // here, not an honest fallback, so it must not be reused for this case.
    const { stdout, stderr, stdoutFn, stderrFn } = captureLines();
    const claudePort = fakeClaudePort({ loggedIn: true });

    const code = await runCli(["whoami"], { env: {}, stdout: stdoutFn, stderr: stderrFn, claudePort });

    expect(code).toBe(0);
    expect(stderr).toEqual([]);
    expect(stdout.join("\n")).not.toMatch(/\(not logged in\)/);
  });

  it("sends a claude-port failure to stderr, never stdout, and exits 1", async () => {
    const { stdout, stderr, stdoutFn, stderrFn } = captureLines();
    const claudePort = throwingClaudePort("spawn claude ENOENT");

    const code = await runCli(["whoami"], { env: {}, stdout: stdoutFn, stderr: stderrFn, claudePort });

    expect(code).toBe(1);
    expect(stdout).toEqual([]);
    expect(stderr.join("\n")).toMatch(/ENOENT/);
  });
});

describe("runCli add", () => {
  let stateDir: string;

  beforeEach(async () => {
    stateDir = await mkdtemp(join(tmpdir(), "ccp-cli-add-test-"));
  });

  afterEach(async () => {
    await rm(stateDir, { recursive: true, force: true });
  });

  it("creates a Profile and registers its Alias", async () => {
    const { stdout, stderr, stdoutFn, stderrFn } = captureLines();

    const code = await runCli(["add", "work"], { stateDir, stdout: stdoutFn, stderr: stderrFn });

    expect(code).toBe(0);
    expect(stderr).toEqual([]);
    expect(stdout.join("\n")).toMatch(/work/);

    const registry = await loadRegistry(stateDir);
    expect(registry.profiles.work).toBeDefined();
    expect(registry.profiles.work?.expectedIdentity).toBeNull();
  });

  it("rejects a duplicate Alias with an actionable message on stderr and changes nothing", async () => {
    await runCli(["add", "work"], { stateDir, stdout: () => {}, stderr: () => {} });
    const registryBefore = await loadRegistry(stateDir);

    const { stdout, stderr, stdoutFn, stderrFn } = captureLines();
    const code = await runCli(["add", "work"], { stateDir, stdout: stdoutFn, stderr: stderrFn });

    expect(code).toBe(1);
    expect(stdout).toEqual([]);
    expect(stderr.join("\n")).toMatch(/work/i);

    const registryAfter = await loadRegistry(stateDir);
    expect(registryAfter).toEqual(registryBefore);
  });

  it("requires an alias argument", async () => {
    const { stdout, stderr, stdoutFn, stderrFn } = captureLines();

    const code = await runCli(["add"], { stateDir, stdout: stdoutFn, stderr: stderrFn });

    expect(code).toBe(1);
    expect(stdout).toEqual([]);
    expect(stderr.join("\n")).toMatch(/alias/i);
  });

  it("rejects '(default)' as an Alias since it's reserved for the Default install", async () => {
    const { stdout, stderr, stdoutFn, stderrFn } = captureLines();

    const code = await runCli(["add", "(default)"], { stateDir, stdout: stdoutFn, stderr: stderrFn });

    expect(code).toBe(1);
    expect(stdout).toEqual([]);
    expect(stderr.join("\n")).toMatch(/reserved/i);
  });
});

describe("runCli ls", () => {
  let stateDir: string;

  beforeEach(async () => {
    stateDir = await mkdtemp(join(tmpdir(), "ccp-cli-ls-test-"));
  });

  afterEach(async () => {
    await rm(stateDir, { recursive: true, force: true });
  });

  it("lists a never-logged-in Profile alongside the Default install, marked unmanaged", async () => {
    await runCli(["add", "work"], { stateDir, stdout: () => {}, stderr: () => {} });
    const claudePort = fakeClaudePort({ loggedIn: true, email: "dev@example.com", orgName: "Acme Corp" });

    const { stdout, stderr, stdoutFn, stderrFn } = captureLines();
    const code = await runCli(["ls"], { stateDir, stdout: stdoutFn, stderr: stderrFn, claudePort });

    expect(code).toBe(0);
    expect(stderr).toEqual([]);
    const report = stdout.join("\n");
    expect(report).toMatch(/\bwork\b/);
    expect(report).toMatch(/never logged in/i);
    expect(report).toMatch(/\(default\)/);
    expect(report).toMatch(/dev@example\.com/);
    expect(report).toMatch(/unmanaged/i);
    // The Default install row is asked about via the ambient environment, no directory override.
    expect(claudePort.calls).toEqual([undefined]);
  });

  it("lists the Default install even when no Profile has been added yet", async () => {
    const claudePort = fakeClaudePort({ loggedIn: false });
    const { stdout, stderr, stdoutFn, stderrFn } = captureLines();

    const code = await runCli(["ls"], { stateDir, stdout: stdoutFn, stderr: stderrFn, claudePort });

    expect(code).toBe(0);
    expect(stderr).toEqual([]);
    expect(stdout.join("\n")).toMatch(/\(default\)/);
  });

  it("produces an actionable error, not a crash, when the registry file is malformed", async () => {
    await writeFile(join(stateDir, "registry.json"), "not json", "utf8");
    const claudePort = fakeClaudePort({ loggedIn: false });
    const { stdout, stderr, stdoutFn, stderrFn } = captureLines();

    const code = await runCli(["ls"], { stateDir, stdout: stdoutFn, stderr: stderrFn, claudePort });

    expect(code).toBe(1);
    expect(stdout).toEqual([]);
    expect(stderr.join("\n")).toMatch(/registry/i);
  });
});
