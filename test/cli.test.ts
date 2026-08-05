import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli.js";
import type { AuthStatus, ClaudePort } from "../src/claude-port.js";
import type { Picker, PickerRow } from "../src/picker.js";
import { addProfile, loadRegistry, recordExpectedIdentity } from "../src/registry.js";

/** Captures every line written to stdout/stderr, in order, for assertion. */
function captureLines(): { stdout: string[]; stderr: string[]; stdoutFn: (line: string) => void; stderrFn: (line: string) => void } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return { stdout, stderr, stdoutFn: (line) => stdout.push(line), stderrFn: (line) => stderr.push(line) };
}

/**
 * A fake ClaudePort that resolves `authStatus` to a fixed AuthStatus and records what it was
 * asked. `login` succeeds by default (or rejects with `loginError`, if given) and records its own
 * calls separately, so tests can assert login was (or wasn't) triggered independently of whoami.
 */
function fakeClaudePort(
  status: AuthStatus,
  options?: { loginError?: string },
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
  };
}

function throwingClaudePort(message: string): ClaudePort {
  return {
    async login() {},
    async authStatus() {
      throw new Error(message);
    },
  };
}

/** A fake {@link Picker}: hands `select` every row it was shown and returns whatever `select`
 * decides — a chosen Alias, or `undefined` to simulate cancelling. */
function fakePicker(select: (rows: PickerRow[]) => string | undefined): Picker & { calls: PickerRow[][] } {
  const calls: PickerRow[][] = [];
  return {
    calls,
    async pick(rows) {
      calls.push(rows);
      return select(rows);
    },
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
    // Login is never triggered implicitly by any other command (CONTEXT.md's Login).
    expect(claudePort.loginCalls).toEqual([]);
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

describe("runCli login", () => {
  let stateDir: string;

  beforeEach(async () => {
    stateDir = await mkdtemp(join(tmpdir(), "ccp-cli-login-test-"));
  });

  afterEach(async () => {
    await rm(stateDir, { recursive: true, force: true });
  });

  it("requires an alias", async () => {
    const { stdout, stderr, stdoutFn, stderrFn } = captureLines();
    const claudePort = fakeClaudePort({ loggedIn: false });

    const code = await runCli(["login"], { env: {}, stdout: stdoutFn, stderr: stderrFn, claudePort, stateDir });

    expect(code).toBe(1);
    expect(stdout).toEqual([]);
    expect(stderr.join("\n")).toMatch(/usage/i);
    expect(claudePort.loginCalls).toEqual([]);
  });

  it("rejects an alias that would escape the state directory, without touching the login flow", async () => {
    const { stdout, stderr, stdoutFn, stderrFn } = captureLines();
    const claudePort = fakeClaudePort({ loggedIn: false });

    const code = await runCli(["login", "../etc"], { env: {}, stdout: stdoutFn, stderr: stderrFn, claudePort, stateDir });

    expect(code).toBe(1);
    expect(stdout).toEqual([]);
    expect(stderr.join("\n")).toMatch(/alias/i);
    expect(claudePort.loginCalls).toEqual([]);

    const registry = await loadRegistry(stateDir);
    expect(registry).toEqual({ profiles: {} });
  });

  it("auto-provisions a Profile that was never `ccp add`ed, under the same config directory `ccp add` would use", async () => {
    const { stdout, stderr, stdoutFn, stderrFn } = captureLines();
    const claudePort = fakeClaudePort({ loggedIn: true, email: "work@example.com", orgName: "Work Org" });

    const code = await runCli(["login", "work"], { env: {}, stdout: stdoutFn, stderr: stderrFn, claudePort, stateDir });

    expect(code).toBe(0);
    expect(stderr).toEqual([]);
    const expectedConfigDir = join(stateDir, "profiles", "work");
    expect(claudePort.loginCalls).toEqual([expectedConfigDir]);
    expect(claudePort.calls).toEqual([expectedConfigDir]);

    const registry = await loadRegistry(stateDir);
    expect(registry.profiles.work).toEqual({
      configDir: expectedConfigDir,
      expectedIdentity: { email: "work@example.com", orgName: "Work Org" },
    });
  });

  it("reuses the config directory `ccp add` already created, rather than provisioning a second one", async () => {
    await runCli(["add", "work"], { stateDir, stdout: () => {}, stderr: () => {} });
    const { configDir } = (await loadRegistry(stateDir)).profiles.work!;

    const claudePort = fakeClaudePort({ loggedIn: true, email: "work@example.com", orgName: "Work Org" });
    const code = await runCli(["login", "work"], { env: {}, stdout: () => {}, stderr: () => {}, claudePort, stateDir });

    expect(code).toBe(0);
    expect(claudePort.loginCalls).toEqual([configDir]);

    const registry = await loadRegistry(stateDir);
    expect(registry.profiles.work).toEqual({
      configDir,
      expectedIdentity: { email: "work@example.com", orgName: "Work Org" },
    });
  });

  it("fails without recording anything when claude reports logged-in but omits email/orgName", async () => {
    // AuthStatus's shape permits this even though the real `claude auth status --json` never
    // does it (ADR-0005) — recording a placeholder here would fabricate Expected identity data.
    const { stdout, stderr, stdoutFn, stderrFn } = captureLines();
    const claudePort = fakeClaudePort({ loggedIn: true });

    const code = await runCli(["login", "work"], { env: {}, stdout: stdoutFn, stderr: stderrFn, claudePort, stateDir });

    expect(code).toBe(1);
    expect(stdout).toEqual([]);
    expect(stderr.join("\n")).toMatch(/did not report/i);
    const registry = await loadRegistry(stateDir);
    expect(registry.profiles.work?.expectedIdentity).toBeNull();
  });

  it("logs a Profile in, scoped to its own config directory, and records the resulting identity", async () => {
    const { stdout, stderr, stdoutFn, stderrFn } = captureLines();
    const claudePort = fakeClaudePort({ loggedIn: true, email: "work@example.com", orgName: "Work Org" });

    const code = await runCli(["login", "work"], { env: {}, stdout: stdoutFn, stderr: stderrFn, claudePort, stateDir });

    expect(code).toBe(0);
    expect(stderr).toEqual([]);
    const expectedConfigDir = join(stateDir, "profiles", "work");
    expect(claudePort.loginCalls).toEqual([expectedConfigDir]);
    expect(claudePort.calls).toEqual([expectedConfigDir]);
    const report = stdout.join("\n");
    expect(report).toMatch(/work@example\.com/);
    expect(report).toMatch(/Work Org/);

    const registry = await loadRegistry(stateDir);
    expect(registry.profiles.work?.expectedIdentity).toEqual({
      email: "work@example.com",
      orgName: "Work Org",
    });
  });

  it("fails without recording anything when the login flow itself fails", async () => {
    const { stdout, stderr, stdoutFn, stderrFn } = captureLines();
    const claudePort = fakeClaudePort({ loggedIn: false }, { loginError: "user closed the browser" });

    const code = await runCli(["login", "work"], { env: {}, stdout: stdoutFn, stderr: stderrFn, claudePort, stateDir });

    expect(code).toBe(1);
    expect(stdout).toEqual([]);
    expect(stderr.join("\n")).toMatch(/closed the browser/);
    const registry = await loadRegistry(stateDir);
    expect(registry.profiles.work?.expectedIdentity).toBeNull();
  });

  it("fails without recording anything when the Profile is still not logged in afterwards", async () => {
    const { stdout, stderr, stdoutFn, stderrFn } = captureLines();
    const claudePort = fakeClaudePort({ loggedIn: false });

    const code = await runCli(["login", "work"], { env: {}, stdout: stdoutFn, stderr: stderrFn, claudePort, stateDir });

    expect(code).toBe(1);
    expect(stdout).toEqual([]);
    const registry = await loadRegistry(stateDir);
    expect(registry.profiles.work?.expectedIdentity).toBeNull();
  });

  it("logging in one Profile leaves every other Profile's recorded identity intact", async () => {
    // Real registry file under a real temp stateDir (no fake) — only the unavoidable, unautomatable
    // part (the actual `claude auth login` browser flow) is faked. This is the isolation
    // acceptance criterion, verified against real behaviour rather than a fake.
    const workPort = fakeClaudePort({ loggedIn: true, email: "work@example.com", orgName: "Work Org" });
    const codeWork = await runCli(["login", "work"], { env: {}, stdout: () => {}, stderr: () => {}, claudePort: workPort, stateDir });
    expect(codeWork).toBe(0);

    const personalPort = fakeClaudePort({ loggedIn: true, email: "me@example.com", orgName: "Personal Org" });
    const codePersonal = await runCli(["login", "personal"], {
      env: {},
      stdout: () => {},
      stderr: () => {},
      claudePort: personalPort,
      stateDir,
    });
    expect(codePersonal).toBe(0);

    const registry = await loadRegistry(stateDir);
    expect(registry.profiles.work?.expectedIdentity).toEqual({
      email: "work@example.com",
      orgName: "Work Org",
    });
    expect(registry.profiles.personal?.expectedIdentity).toEqual({
      email: "me@example.com",
      orgName: "Personal Org",
    });
  });
});

describe("runCli use", () => {
  let stateDir: string;

  beforeEach(async () => {
    stateDir = await mkdtemp(join(tmpdir(), "ccp-cli-use-test-"));
  });

  afterEach(async () => {
    await rm(stateDir, { recursive: true, force: true });
  });

  it("fails without printing anything to stdout when the Alias is unknown", async () => {
    const { stdout, stderr, stdoutFn, stderrFn } = captureLines();
    const claudePort = fakeClaudePort({ loggedIn: true, email: "dev@example.com", orgName: "Acme Corp" });

    const code = await runCli(["use", "ghost"], { stateDir, stdout: stdoutFn, stderr: stderrFn, claudePort });

    expect(code).toBe(1);
    expect(stdout).toEqual([]);
    expect(stderr.join("\n")).toMatch(/unknown alias 'ghost'/i);
    // Never verified — binding an unknown Alias must fail before ever asking `claude` about it.
    expect(claudePort.calls).toEqual([]);
  });

  it("fails without printing anything to stdout when no Alias is given and no Profiles are registered", async () => {
    const { stdout, stderr, stdoutFn, stderrFn } = captureLines();

    const code = await runCli(["use"], { stateDir, stdout: stdoutFn, stderr: stderrFn });

    expect(code).toBe(1);
    expect(stdout).toEqual([]);
    expect(stderr.join("\n")).toMatch(/no profiles are registered/i);
  });

  it("prints only an export statement to stdout for a known, logged-in Profile", async () => {
    const { configDir } = await addProfile(stateDir, "work");
    const { stdout, stderr, stdoutFn, stderrFn } = captureLines();
    const claudePort = fakeClaudePort({ loggedIn: true, email: "work@example.com", orgName: "Work Org" });

    const code = await runCli(["use", "work"], { stateDir, stdout: stdoutFn, stderr: stderrFn, claudePort });

    expect(code).toBe(0);
    expect(stderr).toEqual([]);
    expect(stdout).toEqual([`export CLAUDE_CONFIG_DIR='${configDir}'`]);
    // Verified against the Profile's own directory, not whatever's ambient.
    expect(claudePort.calls).toEqual([configDir]);
  });

  it("still binds, but warns on stderr, when the Profile is logged out", async () => {
    const { configDir } = await addProfile(stateDir, "work");
    const { stdout, stderr, stdoutFn, stderrFn } = captureLines();
    const claudePort = fakeClaudePort({ loggedIn: false });

    const code = await runCli(["use", "work"], { stateDir, stdout: stdoutFn, stderr: stderrFn, claudePort });

    expect(code).toBe(0);
    expect(stdout).toEqual([`export CLAUDE_CONFIG_DIR='${configDir}'`]);
    expect(stderr.join("\n")).toMatch(/'work'.*not logged in/i);
  });

  it("still binds, but warns on stderr, when the observed identity has drifted from the recorded Expected identity", async () => {
    const { configDir } = await addProfile(stateDir, "work");
    await recordExpectedIdentity(stateDir, "work", { email: "old@example.com", orgName: "Old Org" });
    const { stdout, stderr, stdoutFn, stderrFn } = captureLines();
    const claudePort = fakeClaudePort({ loggedIn: true, email: "new@example.com", orgName: "New Org" });

    const code = await runCli(["use", "work"], { stateDir, stdout: stdoutFn, stderr: stderrFn, claudePort });

    expect(code).toBe(0);
    expect(stdout).toEqual([`export CLAUDE_CONFIG_DIR='${configDir}'`]);
    expect(stderr.join("\n")).toMatch(/drift/i);
  });

  it("does not warn when the observed identity matches the recorded Expected identity", async () => {
    await addProfile(stateDir, "work");
    await recordExpectedIdentity(stateDir, "work", { email: "work@example.com", orgName: "Work Org" });
    const { stdout, stderr, stdoutFn, stderrFn } = captureLines();
    const claudePort = fakeClaudePort({ loggedIn: true, email: "work@example.com", orgName: "Work Org" });

    const code = await runCli(["use", "work"], { stateDir, stdout: stdoutFn, stderr: stderrFn, claudePort });

    expect(code).toBe(0);
    expect(stderr).toEqual([]);
  });

  it("does not warn about Drift for a Profile that has never logged in", async () => {
    await addProfile(stateDir, "work");
    const { stdout, stderr, stdoutFn, stderrFn } = captureLines();
    const claudePort = fakeClaudePort({ loggedIn: true, email: "whatever@example.com", orgName: "Whatever Org" });

    const code = await runCli(["use", "work"], { stateDir, stdout: stdoutFn, stderr: stderrFn, claudePort });

    expect(code).toBe(0);
    expect(stdout).toEqual([`export CLAUDE_CONFIG_DIR='${(await loadRegistry(stateDir)).profiles.work?.configDir}'`]);
    expect(stderr).toEqual([]);
  });

  it("fails without printing anything to stdout when the ClaudePort throws", async () => {
    await addProfile(stateDir, "work");
    const { stdout, stderr, stdoutFn, stderrFn } = captureLines();
    const claudePort = throwingClaudePort("spawn claude ENOENT");

    const code = await runCli(["use", "work"], { stateDir, stdout: stdoutFn, stderr: stderrFn, claudePort });

    expect(code).toBe(1);
    expect(stdout).toEqual([]);
    expect(stderr.join("\n")).toMatch(/ENOENT/);
  });

  it("fails without printing anything to stdout when the registry file is malformed", async () => {
    await writeFile(join(stateDir, "registry.json"), "not json", "utf8");
    const { stdout, stderr, stdoutFn, stderrFn } = captureLines();
    const claudePort = fakeClaudePort({ loggedIn: true });

    const code = await runCli(["use", "work"], { stateDir, stdout: stdoutFn, stderr: stderrFn, claudePort });

    expect(code).toBe(1);
    expect(stdout).toEqual([]);
    expect(stderr.join("\n")).toMatch(/registry/i);
    expect(claudePort.calls).toEqual([]);
  });
});

describe("runCli use (interactive picker, no Alias given)", () => {
  let stateDir: string;

  beforeEach(async () => {
    stateDir = await mkdtemp(join(tmpdir(), "ccp-cli-use-picker-test-"));
  });

  afterEach(async () => {
    await rm(stateDir, { recursive: true, force: true });
  });

  it("presents every registered Profile, each row showing the Account and Organization it resolves to", async () => {
    const { configDir: workDir } = await addProfile(stateDir, "work");
    const { configDir: personalDir } = await addProfile(stateDir, "personal");
    const claudePort: ClaudePort = {
      async login() {},
      async authStatus(configDir) {
        if (configDir === workDir) return { loggedIn: true, email: "work@example.com", orgName: "Work Org" };
        if (configDir === personalDir) return { loggedIn: false };
        throw new Error(`unexpected configDir '${configDir}'`);
      },
    };
    const picker = fakePicker((rows) => rows[0]?.alias);

    const code = await runCli(["use"], { stateDir, stdout: () => {}, stderr: () => {}, claudePort, picker });

    expect(code).toBe(0);
    expect(picker.calls).toHaveLength(1);
    const rows = picker.calls[0]!;
    expect(rows.map((r) => r.alias)).toEqual(["personal", "work"]);
    expect(rows.find((r) => r.alias === "work")?.label).toMatch(/work@example\.com.*Work Org/);
    expect(rows.find((r) => r.alias === "personal")?.label).toMatch(/not logged in/i);
  });

  it("resolves identities in parallel, not sequentially, so the picker opens promptly with several Profiles", async () => {
    const { configDir: workDir } = await addProfile(stateDir, "work");
    const { configDir: personalDir } = await addProfile(stateDir, "personal");
    const claudePort: ClaudePort = {
      async login() {},
      async authStatus(configDir) {
        await delay(40);
        return { loggedIn: true, email: `${configDir === workDir ? "work" : "personal"}@example.com`, orgName: "Org" };
      },
    };

    const start = Date.now();
    let pickerOpenedAt = -1;
    // Measures only how long it takes to *open* the picker, not the full command — `runUse`
    // deliberately re-verifies the chosen Profile's identity once picked (it may have sat open
    // for a while), which would otherwise mask a sequential resolution behind that unrelated,
    // always-present extra round trip.
    const picker: Picker = {
      async pick(rows) {
        pickerOpenedAt = Date.now() - start;
        return rows[0]?.alias;
      },
    };

    const code = await runCli(["use"], { stateDir, stdout: () => {}, stderr: () => {}, claudePort, picker });

    expect(code).toBe(0);
    // Sequential resolution would open the picker only after ~80ms (2 x 40ms); parallel
    // resolution opens it after ~40ms. The threshold sits well below the sequential total so
    // the assertion is robust to test-runner scheduling jitter while still failing if the two
    // calls were awaited one after another.
    expect(pickerOpenedAt).toBeLessThan(70);
  });

  it("prints only the resulting export to stdout once a Profile is chosen from the picker", async () => {
    const { configDir } = await addProfile(stateDir, "work");
    const { stdout, stderr, stdoutFn, stderrFn } = captureLines();
    const claudePort = fakeClaudePort({ loggedIn: true, email: "work@example.com", orgName: "Work Org" });
    const picker = fakePicker(() => "work");

    const code = await runCli(["use"], { stateDir, stdout: stdoutFn, stderr: stderrFn, claudePort, picker });

    expect(code).toBe(0);
    expect(stderr).toEqual([]);
    expect(stdout).toEqual([`export CLAUDE_CONFIG_DIR='${configDir}'`]);
  });

  it("leaves the shell unchanged when the picker is cancelled", async () => {
    await addProfile(stateDir, "work");
    const { stdout, stderr, stdoutFn, stderrFn } = captureLines();
    const claudePort = fakeClaudePort({ loggedIn: true, email: "work@example.com", orgName: "Work Org" });
    const picker = fakePicker(() => undefined);

    const code = await runCli(["use"], { stateDir, stdout: stdoutFn, stderr: stderrFn, claudePort, picker });

    expect(code).toBe(1);
    expect(stdout).toEqual([]);
  });

  it("fails with a clear message, without invoking the picker, when no Profiles are registered", async () => {
    const { stdout, stderr, stdoutFn, stderrFn } = captureLines();
    const claudePort = fakeClaudePort({ loggedIn: true });
    const picker = fakePicker(() => "irrelevant");

    const code = await runCli(["use"], { stateDir, stdout: stdoutFn, stderr: stderrFn, claudePort, picker });

    expect(code).toBe(1);
    expect(stdout).toEqual([]);
    expect(stderr.join("\n")).toMatch(/no profiles are registered/i);
    expect(picker.calls).toEqual([]);
  });

  it("fails without invoking the picker when the registry file is malformed", async () => {
    await writeFile(join(stateDir, "registry.json"), "not json", "utf8");
    const { stdout, stderr, stdoutFn, stderrFn } = captureLines();
    const claudePort = fakeClaudePort({ loggedIn: true });
    const picker = fakePicker(() => "irrelevant");

    const code = await runCli(["use"], { stateDir, stdout: stdoutFn, stderr: stderrFn, claudePort, picker });

    expect(code).toBe(1);
    expect(stdout).toEqual([]);
    expect(stderr.join("\n")).toMatch(/registry/i);
    expect(picker.calls).toEqual([]);
  });

  it("fails without invoking the picker when a Profile's identity can't be resolved", async () => {
    await addProfile(stateDir, "work");
    const { stdout, stderr, stdoutFn, stderrFn } = captureLines();
    const claudePort = throwingClaudePort("spawn claude ENOENT");
    const picker = fakePicker(() => "irrelevant");

    const code = await runCli(["use"], { stateDir, stdout: stdoutFn, stderr: stderrFn, claudePort, picker });

    expect(code).toBe(1);
    expect(stdout).toEqual([]);
    expect(stderr.join("\n")).toMatch(/ENOENT/);
    expect(picker.calls).toEqual([]);
  });

  it("fails with a clear message rather than hanging when invoked outside an interactive terminal", async () => {
    // No `picker` option given — this exercises the real default TtyPicker, and vitest's own
    // process never has an interactive stdin, so this is the real non-interactive path, not a
    // simulation of it.
    await addProfile(stateDir, "work");
    const { stdout, stderr, stdoutFn, stderrFn } = captureLines();
    const claudePort = fakeClaudePort({ loggedIn: true, email: "work@example.com", orgName: "Work Org" });

    const code = await runCli(["use"], { stateDir, stdout: stdoutFn, stderr: stderrFn, claudePort });

    expect(code).toBe(1);
    expect(stdout).toEqual([]);
    expect(stderr.join("\n")).toMatch(/interactive terminal/i);
  });
});
