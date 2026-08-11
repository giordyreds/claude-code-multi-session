import { mkdir, mkdtemp, readFile, readlink, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli.js";
import type { AuthStatus, ClaudePort } from "../src/claude-port.js";
import type { CommandRunner } from "../src/command-runner.js";
import type { DaemonPort } from "../src/daemon.js";
import type { Picker, PickerRow } from "../src/picker.js";
import { addProfile, DEFAULT_INSTALL_ALIAS, loadRegistry, recordExpectedIdentity } from "../src/registry.js";

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

/** A fake DaemonPort that records every `configDir` it was asked to stop, and optionally rejects
 * (to exercise `ccp rm`'s "best-effort — never fails removal" acceptance criterion). */
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

/** A fake {@link CommandRunner}: records every command it was asked to run and resolves the given
 * exit code (and, for a signal-killed command, `signal` instead) without ever spawning a real
 * process. */
function fakeCommandRunner(
  exitCode: number | null,
  signal: NodeJS.Signals | null = null,
): CommandRunner & { calls: Array<{ command: string; args: string[]; env: NodeJS.ProcessEnv }> } {
  const calls: Array<{ command: string; args: string[]; env: NodeJS.ProcessEnv }> = [];
  const runner = async (command: string, args: string[], options: { env: NodeJS.ProcessEnv }) => {
    calls.push({ command, args, env: options.env });
    return { exitCode, signal };
  };
  return Object.assign(runner, { calls });
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

describe("runCli ls", () => {
  let stateDir: string;
  let installDir: string;

  beforeEach(async () => {
    stateDir = await mkdtemp(join(tmpdir(), "ccp-cli-ls-test-"));
    installDir = await mkdtemp(join(tmpdir(), "ccp-cli-ls-install-"));
  });

  afterEach(async () => {
    await rm(stateDir, { recursive: true, force: true });
    await rm(installDir, { recursive: true, force: true });
  });

  it("lists a never-logged-in Profile alongside the Default install, marked unmanaged", async () => {
    await runCli(["add", "work"], { stateDir, installDir, stdout: () => {}, stderr: () => {} });
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
  let installDir: string;

  beforeEach(async () => {
    stateDir = await mkdtemp(join(tmpdir(), "ccp-cli-login-test-"));
    installDir = await mkdtemp(join(tmpdir(), "ccp-cli-login-install-"));
  });

  afterEach(async () => {
    await rm(stateDir, { recursive: true, force: true });
    await rm(installDir, { recursive: true, force: true });
  });

  it("requires an alias", async () => {
    const { stdout, stderr, stdoutFn, stderrFn } = captureLines();
    const claudePort = fakeClaudePort({ loggedIn: false });

    const code = await runCli(["login"], { env: {}, stdout: stdoutFn, stderr: stderrFn, claudePort, stateDir, installDir });

    expect(code).toBe(1);
    expect(stdout).toEqual([]);
    expect(stderr.join("\n")).toMatch(/usage/i);
    expect(claudePort.loginCalls).toEqual([]);
  });

  it("rejects an alias that would escape the state directory, without touching the login flow", async () => {
    const { stdout, stderr, stdoutFn, stderrFn } = captureLines();
    const claudePort = fakeClaudePort({ loggedIn: false });

    const code = await runCli(["login", "../etc"], { env: {}, stdout: stdoutFn, stderr: stderrFn, claudePort, stateDir, installDir });

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

    const code = await runCli(["login", "work"], { env: {}, stdout: stdoutFn, stderr: stderrFn, claudePort, stateDir, installDir });

    expect(code).toBe(0);
    expect(stderr).toEqual([]);
    const expectedConfigDir = join(stateDir, "profiles", "work");
    expect(claudePort.loginCalls).toEqual([expectedConfigDir]);
    expect(claudePort.calls).toEqual([expectedConfigDir]);

    const registry = await loadRegistry(stateDir);
    expect(registry.profiles.work).toEqual({
      configDir: expectedConfigDir,
      expectedIdentity: { email: "work@example.com", orgName: "Work Org" },
      drifted: false,
    });
  });

  it("reuses the config directory `ccp add` already created, rather than provisioning a second one", async () => {
    await runCli(["add", "work"], { stateDir, installDir, stdout: () => {}, stderr: () => {} });
    const { configDir } = (await loadRegistry(stateDir)).profiles.work!;

    const claudePort = fakeClaudePort({ loggedIn: true, email: "work@example.com", orgName: "Work Org" });
    const code = await runCli(["login", "work"], { env: {}, stdout: () => {}, stderr: () => {}, claudePort, stateDir, installDir });

    expect(code).toBe(0);
    expect(claudePort.loginCalls).toEqual([configDir]);

    const registry = await loadRegistry(stateDir);
    expect(registry.profiles.work).toEqual({
      configDir,
      expectedIdentity: { email: "work@example.com", orgName: "Work Org" },
      drifted: false,
    });
  });

  it("fails without recording anything when claude reports logged-in but omits email/orgName", async () => {
    // AuthStatus's shape permits this even though the real `claude auth status --json` never
    // does it (ADR-0005) — recording a placeholder here would fabricate Expected identity data.
    const { stdout, stderr, stdoutFn, stderrFn } = captureLines();
    const claudePort = fakeClaudePort({ loggedIn: true });

    const code = await runCli(["login", "work"], { env: {}, stdout: stdoutFn, stderr: stderrFn, claudePort, stateDir, installDir });

    expect(code).toBe(1);
    expect(stdout).toEqual([]);
    expect(stderr.join("\n")).toMatch(/did not report/i);
    const registry = await loadRegistry(stateDir);
    expect(registry.profiles.work?.expectedIdentity).toBeNull();
  });

  it("logs a Profile in, scoped to its own config directory, and records the resulting identity", async () => {
    const { stdout, stderr, stdoutFn, stderrFn } = captureLines();
    const claudePort = fakeClaudePort({ loggedIn: true, email: "work@example.com", orgName: "Work Org" });

    const code = await runCli(["login", "work"], { env: {}, stdout: stdoutFn, stderr: stderrFn, claudePort, stateDir, installDir });

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

    const code = await runCli(["login", "work"], { env: {}, stdout: stdoutFn, stderr: stderrFn, claudePort, stateDir, installDir });

    expect(code).toBe(1);
    expect(stdout).toEqual([]);
    expect(stderr.join("\n")).toMatch(/closed the browser/);
    const registry = await loadRegistry(stateDir);
    expect(registry.profiles.work?.expectedIdentity).toBeNull();
  });

  it("fails without recording anything when the Profile is still not logged in afterwards", async () => {
    const { stdout, stderr, stdoutFn, stderrFn } = captureLines();
    const claudePort = fakeClaudePort({ loggedIn: false });

    const code = await runCli(["login", "work"], { env: {}, stdout: stdoutFn, stderr: stderrFn, claudePort, stateDir, installDir });

    expect(code).toBe(1);
    expect(stdout).toEqual([]);
    const registry = await loadRegistry(stateDir);
    expect(registry.profiles.work?.expectedIdentity).toBeNull();
  });

  it("pre-seeds the Profile's onboarding state from the Default install after a successful login", async () => {
    // Its own scratch dir, deliberately separate from `installDir` — the real Default install's
    // `.claude.json` is a sibling of `~/.claude`, not nested inside it (src/cli.ts's
    // `defaultInstallStateFilePath`), and this fixture mirrors that shape rather than implying a
    // nesting relationship that doesn't exist.
    const installStateScratchDir = await mkdtemp(join(tmpdir(), "ccp-cli-login-install-state-"));
    const installStateFilePath = join(installStateScratchDir, ".claude.json");
    await writeFile(
      installStateFilePath,
      JSON.stringify({ hasCompletedOnboarding: true, lastOnboardingVersion: "2.1.221" }),
      "utf8",
    );
    const configDir = join(stateDir, "profiles", "work");
    await mkdir(configDir, { recursive: true });
    await writeFile(join(configDir, ".claude.json"), JSON.stringify({ oauthAccount: {} }), "utf8");

    try {
      const claudePort = fakeClaudePort({ loggedIn: true, email: "work@example.com", orgName: "Work Org" });
      const code = await runCli(["login", "work"], {
        env: {},
        stdout: () => {},
        stderr: () => {},
        claudePort,
        stateDir,
        installDir,
        installStateFilePath,
      });

      expect(code).toBe(0);
      const seeded = JSON.parse(await readFile(join(configDir, ".claude.json"), "utf8"));
      expect(seeded).toEqual({ oauthAccount: {}, hasCompletedOnboarding: true, lastOnboardingVersion: "2.1.221" });
    } finally {
      await rm(installStateScratchDir, { recursive: true, force: true });
    }
  });

  it("never calls the onboarding seeder when the login flow itself fails", async () => {
    const claudePort = fakeClaudePort({ loggedIn: false }, { loginError: "user closed the browser" });
    const seederCalls: Array<[string, string]> = [];
    const onboardingSeeder = async (installStateFilePathArg: string, configDirArg: string) => {
      seederCalls.push([installStateFilePathArg, configDirArg]);
      return { seeded: false };
    };

    const code = await runCli(["login", "work"], { env: {}, stdout: () => {}, stderr: () => {}, claudePort, stateDir, installDir, onboardingSeeder });

    expect(code).toBe(1);
    expect(seederCalls).toEqual([]);
  });

  it("warns but still succeeds when the onboarding pre-seed fails unexpectedly", async () => {
    const { stdout, stderr, stdoutFn, stderrFn } = captureLines();
    const claudePort = fakeClaudePort({ loggedIn: true, email: "work@example.com", orgName: "Work Org" });
    const onboardingSeeder = async () => {
      throw new Error("disk full");
    };

    const code = await runCli(["login", "work"], {
      env: {},
      stdout: stdoutFn,
      stderr: stderrFn,
      claudePort,
      stateDir,
      installDir,
      onboardingSeeder,
    });

    expect(code).toBe(0);
    expect(stderr.join("\n")).toMatch(/onboarding.*disk full/i);
    expect(stdout.join("\n")).toMatch(/work@example\.com/);
    const registry = await loadRegistry(stateDir);
    expect(registry.profiles.work?.expectedIdentity).toEqual({ email: "work@example.com", orgName: "Work Org" });
  });

  it("logging in one Profile leaves every other Profile's recorded identity intact", async () => {
    // Real registry file under a real temp stateDir (no fake) — only the unavoidable, unautomatable
    // part (the actual `claude auth login` browser flow) is faked. This is the isolation
    // acceptance criterion, verified against real behaviour rather than a fake.
    const workPort = fakeClaudePort({ loggedIn: true, email: "work@example.com", orgName: "Work Org" });
    const codeWork = await runCli(["login", "work"], { env: {}, stdout: () => {}, stderr: () => {}, claudePort: workPort, stateDir, installDir });
    expect(codeWork).toBe(0);

    const personalPort = fakeClaudePort({ loggedIn: true, email: "me@example.com", orgName: "Personal Org" });
    const codePersonal = await runCli(["login", "personal"], {
      env: {},
      stdout: () => {},
      stderr: () => {},
      claudePort: personalPort,
      stateDir,
      installDir,
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
  });

  // With no Alias and no Profiles registered, `ccp use` no longer requires an Alias up front
  // (ticket #9) — it falls through to the interactive picker, which reports this exact case
  // itself. See "runCli use (interactive picker, no Alias given)" below.

  it("binds a known, non-drifted Profile: only an export statement reaches stdout", async () => {
    await runCli(["login", "work"], {
      env: {},
      stdout: () => {},
      stderr: () => {},
      stateDir,
      claudePort: fakeClaudePort({ loggedIn: true, email: "work@example.com", orgName: "Work Org" }),
    });
    const { configDir } = (await loadRegistry(stateDir)).profiles.work!;

    const { stdout, stderr, stdoutFn, stderrFn } = captureLines();
    const claudePort = fakeClaudePort({ loggedIn: true, email: "work@example.com", orgName: "Work Org" });

    const code = await runCli(["use", "work"], { stateDir, stdout: stdoutFn, stderr: stderrFn, claudePort });

    expect(code).toBe(0);
    expect(stderr).toEqual([]);
    expect(stdout).toEqual([`export CLAUDE_CONFIG_DIR='${configDir}'`]);
    expect(claudePort.calls).toEqual([configDir]);
    // Never authenticates or opens a browser (CONTEXT.md's Binding, distinct from Login).
    expect(claudePort.loginCalls).toEqual([]);
  });

  it("still binds a logged-out Profile, with the warning on stderr rather than stdout", async () => {
    await runCli(["add", "work"], { stateDir, stdout: () => {}, stderr: () => {} });
    const { configDir } = (await loadRegistry(stateDir)).profiles.work!;

    const { stdout, stderr, stdoutFn, stderrFn } = captureLines();
    const claudePort = fakeClaudePort({ loggedIn: false });

    const code = await runCli(["use", "work"], { stateDir, stdout: stdoutFn, stderr: stderrFn, claudePort });

    expect(code).toBe(0);
    expect(stdout).toEqual([`export CLAUDE_CONFIG_DIR='${configDir}'`]);
    expect(stderr.join("\n")).toMatch(/not logged in/i);
  });

  it("still binds a drifted Profile, warning prominently on stderr and naming both identities", async () => {
    await runCli(["login", "work"], {
      env: {},
      stdout: () => {},
      stderr: () => {},
      stateDir,
      claudePort: fakeClaudePort({ loggedIn: true, email: "work@example.com", orgName: "Work Org" }),
    });
    const { configDir } = (await loadRegistry(stateDir)).profiles.work!;

    const { stdout, stderr, stdoutFn, stderrFn } = captureLines();
    const claudePort = fakeClaudePort({ loggedIn: true, email: "someone-else@example.com", orgName: "Other Org" });

    const code = await runCli(["use", "work"], { stateDir, stdout: stdoutFn, stderr: stderrFn, claudePort });

    expect(code).toBe(0);
    // Drift is a warning, never a block — Binding still succeeds.
    expect(stdout).toEqual([`export CLAUDE_CONFIG_DIR='${configDir}'`]);
    const report = stderr.join("\n");
    expect(report).toMatch(/drift/i);
    expect(report).toMatch(/work@example\.com/);
    expect(report).toMatch(/Work Org/);
    expect(report).toMatch(/someone-else@example\.com/);
    expect(report).toMatch(/Other Org/);

    const registry = await loadRegistry(stateDir);
    expect(registry.profiles.work?.drifted).toBe(true);
    // Reconciliation is the only thing allowed to change what's recorded as expected.
    expect(registry.profiles.work?.expectedIdentity).toEqual({ email: "work@example.com", orgName: "Work Org" });
  });

  it("clears a previously recorded Drift once the observed identity matches again", async () => {
    await runCli(["login", "work"], {
      env: {},
      stdout: () => {},
      stderr: () => {},
      stateDir,
      claudePort: fakeClaudePort({ loggedIn: true, email: "work@example.com", orgName: "Work Org" }),
    });
    await runCli(["use", "work"], {
      stateDir,
      stdout: () => {},
      stderr: () => {},
      claudePort: fakeClaudePort({ loggedIn: true, email: "drifted@example.com", orgName: "Drifted Org" }),
    });
    expect((await loadRegistry(stateDir)).profiles.work?.drifted).toBe(true);

    const { stderr, stderrFn } = captureLines();
    const code = await runCli(["use", "work"], {
      stateDir,
      stdout: () => {},
      stderr: stderrFn,
      claudePort: fakeClaudePort({ loggedIn: true, email: "work@example.com", orgName: "Work Org" }),
    });

    expect(code).toBe(0);
    expect(stderr).toEqual([]);
    expect((await loadRegistry(stateDir)).profiles.work?.drifted).toBe(false);
  });

  it("leaves a previously recorded Drift untouched when the Profile is logged out — nothing was observed to disprove it", async () => {
    await runCli(["login", "work"], {
      env: {},
      stdout: () => {},
      stderr: () => {},
      stateDir,
      claudePort: fakeClaudePort({ loggedIn: true, email: "work@example.com", orgName: "Work Org" }),
    });
    await runCli(["use", "work"], {
      stateDir,
      stdout: () => {},
      stderr: () => {},
      claudePort: fakeClaudePort({ loggedIn: true, email: "drifted@example.com", orgName: "Drifted Org" }),
    });
    expect((await loadRegistry(stateDir)).profiles.work?.drifted).toBe(true);

    const { stderr, stderrFn } = captureLines();
    const code = await runCli(["use", "work"], {
      stateDir,
      stdout: () => {},
      stderr: stderrFn,
      claudePort: fakeClaudePort({ loggedIn: false }),
    });

    expect(code).toBe(0);
    expect(stderr.join("\n")).toMatch(/not logged in/i);
    expect((await loadRegistry(stateDir)).profiles.work?.drifted).toBe(true);
  });

  it("sends a hard claude-port failure to stderr, never stdout, and exits 1", async () => {
    await runCli(["add", "work"], { stateDir, stdout: () => {}, stderr: () => {} });

    const { stdout, stderr, stdoutFn, stderrFn } = captureLines();
    const claudePort = throwingClaudePort("spawn claude ENOENT");

    const code = await runCli(["use", "work"], { stateDir, stdout: stdoutFn, stderr: stderrFn, claudePort });

    expect(code).toBe(1);
    expect(stdout).toEqual([]);
    expect(stderr.join("\n")).toMatch(/ENOENT/);
  });

  it("single-quotes the export line so an Alias containing shell metacharacters can't break out of it", async () => {
    // isValidAlias (registry.ts) only rejects path traversal, not shell metacharacters, so an
    // Alias like this one is accepted and becomes part of configDir. If the export line were ever
    // interpolated unescaped, `ccp.sh`'s `eval` would run whatever came after the injected quote.
    const alias = `foo"; echo pwned; echo "`;
    await runCli(["add", alias], { stateDir, stdout: () => {}, stderr: () => {} });
    const { configDir } = (await loadRegistry(stateDir)).profiles[alias]!;

    const { stdout, stdoutFn, stderrFn } = captureLines();
    const claudePort = fakeClaudePort({ loggedIn: false });

    const code = await runCli(["use", alias], { stateDir, stdout: stdoutFn, stderr: stderrFn, claudePort });

    expect(code).toBe(0);
    expect(stdout).toEqual([`export CLAUDE_CONFIG_DIR='${configDir.replace(/'/g, `'\\''`)}'`]);
    // The whole value sits inside one pair of single quotes: `eval`-ing it can only ever set
    // CLAUDE_CONFIG_DIR, never run a second, injected command.
    expect(stdout[0]!.match(/'/g)?.length).toBe(2);
  });
});

describe("runCli ls (Drift marking)", () => {
  let stateDir: string;

  beforeEach(async () => {
    stateDir = await mkdtemp(join(tmpdir(), "ccp-cli-ls-drift-test-"));
  });

  afterEach(async () => {
    await rm(stateDir, { recursive: true, force: true });
  });

  it("marks a drifted Profile distinctly, from stored state alone", async () => {
    await runCli(["login", "work"], {
      env: {},
      stdout: () => {},
      stderr: () => {},
      stateDir,
      claudePort: fakeClaudePort({ loggedIn: true, email: "work@example.com", orgName: "Work Org" }),
    });
    await runCli(["use", "work"], {
      stateDir,
      stdout: () => {},
      stderr: () => {},
      claudePort: fakeClaudePort({ loggedIn: true, email: "someone-else@example.com", orgName: "Other Org" }),
    });

    const { stdout, stdoutFn, stderrFn } = captureLines();
    // A ClaudePort that would throw if `ls` ever asked it about a managed Profile — only the
    // Default install row may query it live.
    const claudePort: ClaudePort = {
      async login() {},
      async authStatus(configDir?: string) {
        if (configDir !== undefined) throw new Error(`ls must not live-check a managed Profile (${configDir})`);
        return { loggedIn: false };
      },
    };

    const code = await runCli(["ls"], { stateDir, stdout: stdoutFn, stderr: stderrFn, claudePort });

    expect(code).toBe(0);
    const report = stdout.join("\n");
    expect(report).toMatch(/\bwork\b.*\[DRIFTED\]/i);
  });

  it("does not mark a Profile that has never drifted", async () => {
    await runCli(["login", "work"], {
      env: {},
      stdout: () => {},
      stderr: () => {},
      stateDir,
      claudePort: fakeClaudePort({ loggedIn: true, email: "work@example.com", orgName: "Work Org" }),
    });

    const { stdout, stdoutFn, stderrFn } = captureLines();
    const claudePort = fakeClaudePort({ loggedIn: false });

    const code = await runCli(["ls"], { stateDir, stdout: stdoutFn, stderr: stderrFn, claudePort });

    expect(code).toBe(0);
    expect(stdout.join("\n")).not.toMatch(/DRIFTED/i);
  });
});

describe("runCli reconcile", () => {
  let stateDir: string;

  beforeEach(async () => {
    stateDir = await mkdtemp(join(tmpdir(), "ccp-cli-reconcile-test-"));
  });

  afterEach(async () => {
    await rm(stateDir, { recursive: true, force: true });
  });

  it("requires an alias", async () => {
    const { stdout, stderr, stdoutFn, stderrFn } = captureLines();
    const claudePort = fakeClaudePort({ loggedIn: false });

    const code = await runCli(["reconcile"], { stateDir, stdout: stdoutFn, stderr: stderrFn, claudePort });

    expect(code).toBe(1);
    expect(stdout).toEqual([]);
    expect(stderr.join("\n")).toMatch(/usage/i);
  });

  it("fails for an unknown Alias", async () => {
    const { stdout, stderr, stdoutFn, stderrFn } = captureLines();
    const claudePort = fakeClaudePort({ loggedIn: true, email: "dev@example.com", orgName: "Acme Corp" });

    const code = await runCli(["reconcile", "ghost"], { stateDir, stdout: stdoutFn, stderr: stderrFn, claudePort });

    expect(code).toBe(1);
    expect(stdout).toEqual([]);
    expect(stderr.join("\n")).toMatch(/ghost/i);
  });

  it("accepts the observed identity as the new Expected identity, without ever logging in", async () => {
    await runCli(["login", "work"], {
      env: {},
      stdout: () => {},
      stderr: () => {},
      stateDir,
      claudePort: fakeClaudePort({ loggedIn: true, email: "work@example.com", orgName: "Work Org" }),
    });
    await runCli(["use", "work"], {
      stateDir,
      stdout: () => {},
      stderr: () => {},
      claudePort: fakeClaudePort({ loggedIn: true, email: "someone-else@example.com", orgName: "Other Org" }),
    });
    expect((await loadRegistry(stateDir)).profiles.work?.drifted).toBe(true);

    const { stdout, stderr, stdoutFn, stderrFn } = captureLines();
    const claudePort = fakeClaudePort({ loggedIn: true, email: "someone-else@example.com", orgName: "Other Org" });

    const code = await runCli(["reconcile", "work"], { stateDir, stdout: stdoutFn, stderr: stderrFn, claudePort });

    expect(code).toBe(0);
    expect(stderr).toEqual([]);
    expect(stdout.join("\n")).toMatch(/someone-else@example\.com/);
    // Reconciliation reads identity the same way Drift detection does — it never re-authenticates.
    expect(claudePort.loginCalls).toEqual([]);

    const registry = await loadRegistry(stateDir);
    expect(registry.profiles.work?.expectedIdentity).toEqual({
      email: "someone-else@example.com",
      orgName: "Other Org",
    });
    expect(registry.profiles.work?.drifted).toBe(false);
  });

  it("refuses to reconcile a logged-out Profile — there is no observed identity to accept as truth", async () => {
    await runCli(["add", "work"], { stateDir, stdout: () => {}, stderr: () => {} });

    const { stdout, stderr, stdoutFn, stderrFn } = captureLines();
    const claudePort = fakeClaudePort({ loggedIn: false });

    const code = await runCli(["reconcile", "work"], { stateDir, stdout: stdoutFn, stderr: stderrFn, claudePort });

    expect(code).toBe(1);
    expect(stdout).toEqual([]);
    expect(stderr.join("\n")).toMatch(/not logged in/i);
    expect(claudePort.loginCalls).toEqual([]);
  });

  it("never disturbs another Profile's recorded identity", async () => {
    await runCli(["login", "work"], {
      env: {},
      stdout: () => {},
      stderr: () => {},
      stateDir,
      claudePort: fakeClaudePort({ loggedIn: true, email: "work@example.com", orgName: "Work Org" }),
    });
    await runCli(["login", "personal"], {
      env: {},
      stdout: () => {},
      stderr: () => {},
      stateDir,
      claudePort: fakeClaudePort({ loggedIn: true, email: "me@example.com", orgName: "Personal Org" }),
    });

    const claudePort = fakeClaudePort({ loggedIn: true, email: "someone-else@example.com", orgName: "Other Org" });
    const code = await runCli(["reconcile", "work"], { stateDir, stdout: () => {}, stderr: () => {}, claudePort });

    expect(code).toBe(0);
    const registry = await loadRegistry(stateDir);
    expect(registry.profiles.personal?.expectedIdentity).toEqual({ email: "me@example.com", orgName: "Personal Org" });
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

describe("runCli use (interactive picker, no Alias given)", () => {
  let stateDir: string;
  let installDir: string;

  beforeEach(async () => {
    stateDir = await mkdtemp(join(tmpdir(), "ccp-cli-use-picker-test-"));
    installDir = await mkdtemp(join(tmpdir(), "ccp-cli-use-picker-install-"));
  });

  afterEach(async () => {
    await rm(stateDir, { recursive: true, force: true });
    await rm(installDir, { recursive: true, force: true });
  });

  it("presents every registered Profile, each row showing the Account and Organization it resolves to", async () => {
    const { configDir: workDir } = await addProfile(stateDir, "work", installDir);
    const { configDir: personalDir } = await addProfile(stateDir, "personal", installDir);
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
    const { configDir: workDir } = await addProfile(stateDir, "work", installDir);
    const { configDir: personalDir } = await addProfile(stateDir, "personal", installDir);
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
    const { configDir } = await addProfile(stateDir, "work", installDir);
    const { stdout, stderr, stdoutFn, stderrFn } = captureLines();
    const claudePort = fakeClaudePort({ loggedIn: true, email: "work@example.com", orgName: "Work Org" });
    const picker = fakePicker(() => "work");

    const code = await runCli(["use"], { stateDir, stdout: stdoutFn, stderr: stderrFn, claudePort, picker });

    expect(code).toBe(0);
    expect(stderr).toEqual([]);
    expect(stdout).toEqual([`export CLAUDE_CONFIG_DIR='${configDir}'`]);
  });

  it("leaves the shell unchanged when the picker is cancelled", async () => {
    await addProfile(stateDir, "work", installDir);
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
    await addProfile(stateDir, "work", installDir);
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
    await addProfile(stateDir, "work", installDir);
    const { stdout, stderr, stdoutFn, stderrFn } = captureLines();
    const claudePort = fakeClaudePort({ loggedIn: true, email: "work@example.com", orgName: "Work Org" });

    const code = await runCli(["use"], { stateDir, stdout: stdoutFn, stderr: stderrFn, claudePort });

    expect(code).toBe(1);
    expect(stdout).toEqual([]);
    expect(stderr.join("\n")).toMatch(/interactive terminal/i);
  });
});

describe("runCli run", () => {
  let stateDir: string;
  let installDir: string;

  beforeEach(async () => {
    stateDir = await mkdtemp(join(tmpdir(), "ccp-cli-run-test-"));
    installDir = await mkdtemp(join(tmpdir(), "ccp-cli-run-install-"));
  });

  afterEach(async () => {
    await rm(stateDir, { recursive: true, force: true });
    await rm(installDir, { recursive: true, force: true });
  });

  it("requires an alias", async () => {
    const { stdout, stderr, stdoutFn, stderrFn } = captureLines();
    const commandRunner = fakeCommandRunner(0);

    const code = await runCli(["run"], { stateDir, stdout: stdoutFn, stderr: stderrFn, commandRunner });

    expect(code).toBe(1);
    expect(stdout).toEqual([]);
    expect(stderr.join("\n")).toMatch(/usage/i);
    expect(commandRunner.calls).toEqual([]);
  });

  it("requires the '--' separator between the alias and the command", async () => {
    const { stdout, stderr, stdoutFn, stderrFn } = captureLines();
    const commandRunner = fakeCommandRunner(0);

    const code = await runCli(["run", "work", "echo", "hi"], { stateDir, stdout: stdoutFn, stderr: stderrFn, commandRunner });

    expect(code).toBe(1);
    expect(stdout).toEqual([]);
    expect(stderr.join("\n")).toMatch(/usage/i);
    expect(commandRunner.calls).toEqual([]);
  });

  it("requires a command after the '--' separator", async () => {
    const { stdout, stderr, stdoutFn, stderrFn } = captureLines();
    const commandRunner = fakeCommandRunner(0);

    const code = await runCli(["run", "work", "--"], { stateDir, stdout: stdoutFn, stderr: stderrFn, commandRunner });

    expect(code).toBe(1);
    expect(stdout).toEqual([]);
    expect(stderr.join("\n")).toMatch(/usage/i);
    expect(commandRunner.calls).toEqual([]);
  });

  it("fails for an unknown Alias before the command is ever run", async () => {
    const { stdout, stderr, stdoutFn, stderrFn } = captureLines();
    const commandRunner = fakeCommandRunner(0);

    const code = await runCli(["run", "ghost", "--", "echo", "hi"], { stateDir, stdout: stdoutFn, stderr: stderrFn, commandRunner });

    expect(code).toBe(1);
    expect(stdout).toEqual([]);
    expect(stderr.join("\n")).toMatch(/unknown alias 'ghost'/i);
    expect(commandRunner.calls).toEqual([]);
  });

  it("runs the command with CLAUDE_CONFIG_DIR set to the resolved Profile's config directory, passing args through", async () => {
    const { configDir } = await addProfile(stateDir, "work", installDir);
    const { stdout, stderr, stdoutFn, stderrFn } = captureLines();
    const commandRunner = fakeCommandRunner(0);

    const code = await runCli(["run", "work", "--", "git", "log", "--oneline"], {
      stateDir,
      env: { PATH: "/usr/bin" },
      stdout: stdoutFn,
      stderr: stderrFn,
      commandRunner,
    });

    expect(code).toBe(0);
    expect(stdout).toEqual([]);
    expect(stderr).toEqual([]);
    expect(commandRunner.calls).toHaveLength(1);
    const call = commandRunner.calls[0]!;
    expect(call.command).toBe("git");
    // A '--' that belongs to the command itself (not ccp's own separator) passes through untouched.
    expect(call.args).toEqual(["log", "--oneline"]);
    expect(call.env.CLAUDE_CONFIG_DIR).toBe(configDir);
    // The rest of the invoking environment reaches the child too, not just the override.
    expect(call.env.PATH).toBe("/usr/bin");
  });

  it("passes the spawned command's exit status through untouched", async () => {
    await addProfile(stateDir, "work", installDir);
    const { stdoutFn, stderrFn } = captureLines();
    const commandRunner = fakeCommandRunner(42);

    const code = await runCli(["run", "work", "--", "false"], { stateDir, stdout: stdoutFn, stderr: stderrFn, commandRunner });

    expect(code).toBe(42);
  });

  it("maps a signal-killed command to the 128+signal convention, rather than collapsing it to the same code as a normal exit 1", async () => {
    await addProfile(stateDir, "work", installDir);
    const { stdoutFn, stderrFn } = captureLines();
    const commandRunner = fakeCommandRunner(null, "SIGTERM");

    const code = await runCli(["run", "work", "--", "sleep", "100"], { stateDir, stdout: stdoutFn, stderr: stderrFn, commandRunner });

    expect(code).toBe(128 + 15); // SIGTERM is signal 15
  });

  it("sends a hard command-runner failure (e.g. an unspawnable command) to stderr, never stdout, and exits 1", async () => {
    await addProfile(stateDir, "work", installDir);
    const { stdout, stderr, stdoutFn, stderrFn } = captureLines();
    const commandRunner: CommandRunner = async () => {
      throw new Error("spawn does-not-exist ENOENT");
    };

    const code = await runCli(["run", "work", "--", "does-not-exist"], { stateDir, stdout: stdoutFn, stderr: stderrFn, commandRunner });

    expect(code).toBe(1);
    expect(stdout).toEqual([]);
    expect(stderr.join("\n")).toMatch(/ENOENT/);
  });

  it("really spawns the command: real env passthrough, real args, and a real exit code, with no `run` faking involved", async () => {
    const { configDir } = await addProfile(stateDir, "work", installDir);
    const outFile = join(stateDir, "out.json");
    const script = join(stateDir, "child.mjs");
    await writeFile(
      script,
      [
        "import { writeFileSync } from 'node:fs';",
        `writeFileSync(${JSON.stringify(outFile)}, JSON.stringify({ configDir: process.env.CLAUDE_CONFIG_DIR, args: process.argv.slice(2) }));`,
        "process.exit(7);",
      ].join("\n"),
      "utf8",
    );

    const { stdout, stderr, stdoutFn, stderrFn } = captureLines();

    const code = await runCli(["run", "work", "--", process.execPath, script, "hello", "world"], {
      stateDir,
      stdout: stdoutFn,
      stderr: stderrFn,
    });

    expect(code).toBe(7);
    expect(stdout).toEqual([]);
    expect(stderr).toEqual([]);
    const result = JSON.parse(await readFile(outFile, "utf8"));
    expect(result.configDir).toBe(configDir);
    expect(result.args).toEqual(["hello", "world"]);
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
