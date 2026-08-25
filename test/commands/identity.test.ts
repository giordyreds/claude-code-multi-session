import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ClaudePort } from "../../src/claude-port.js";
import { runCli } from "../../src/cli.js";
import { loadRegistry } from "../../src/registry.js";
import { captureLines, fakeClaudePort, throwingClaudePort } from "./shared.js";

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
    const claudePort = fakeClaudePort({ loggedIn: true, identity: { email: "dev@example.com", orgName: "Acme Corp" } });

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
    const claudePort = fakeClaudePort({ loggedIn: true, identity: { email: "work@example.com", orgName: "Work Org" } });

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

  it("never mislabels a logged-in Profile as '(not logged in)' just because identity came back null", async () => {
    // A ClaudePort implementation could report loggedIn: true with identity: null (the
    // AuthStatus type permits it even though the real `claude auth status --json` always
    // supplies both halves — see ADR-0014). "(not logged in)" would be an outright false
    // statement here, not an honest fallback, so it must not be reused for this case.
    const { stdout, stderr, stdoutFn, stderrFn } = captureLines();
    const claudePort = fakeClaudePort({ loggedIn: true, identity: null });

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
    const claudePort = fakeClaudePort({ loggedIn: true, identity: { email: "dev@example.com", orgName: "Acme Corp" } });

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
    const claudePort = fakeClaudePort({ loggedIn: true, identity: { email: "work@example.com", orgName: "Work Org" } });

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

    const claudePort = fakeClaudePort({ loggedIn: true, identity: { email: "work@example.com", orgName: "Work Org" } });
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

  it("fails without recording anything when claude reports logged-in but identity is null", async () => {
    // AuthStatus's shape permits this even though the real `claude auth status --json` never
    // does it (ADR-0014) — recording a placeholder here would fabricate Expected identity data.
    const { stdout, stderr, stdoutFn, stderrFn } = captureLines();
    const claudePort = fakeClaudePort({ loggedIn: true, identity: null });

    const code = await runCli(["login", "work"], { env: {}, stdout: stdoutFn, stderr: stderrFn, claudePort, stateDir, installDir });

    expect(code).toBe(1);
    expect(stdout).toEqual([]);
    expect(stderr.join("\n")).toMatch(/did not report/i);
    const registry = await loadRegistry(stateDir);
    expect(registry.profiles.work?.expectedIdentity).toBeNull();
  });

  it("logs a Profile in, scoped to its own config directory, and records the resulting identity", async () => {
    const { stdout, stderr, stdoutFn, stderrFn } = captureLines();
    const claudePort = fakeClaudePort({ loggedIn: true, identity: { email: "work@example.com", orgName: "Work Org" } });

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
      const claudePort = fakeClaudePort({ loggedIn: true, identity: { email: "work@example.com", orgName: "Work Org" } });
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
    const claudePort = fakeClaudePort({ loggedIn: true, identity: { email: "work@example.com", orgName: "Work Org" } });
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
    const workPort = fakeClaudePort({ loggedIn: true, identity: { email: "work@example.com", orgName: "Work Org" } });
    const codeWork = await runCli(["login", "work"], { env: {}, stdout: () => {}, stderr: () => {}, claudePort: workPort, stateDir, installDir });
    expect(codeWork).toBe(0);

    const personalPort = fakeClaudePort({ loggedIn: true, identity: { email: "me@example.com", orgName: "Personal Org" } });
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
      claudePort: fakeClaudePort({ loggedIn: true, identity: { email: "work@example.com", orgName: "Work Org" } }),
    });
    await runCli(["use", "work"], {
      stateDir,
      stdout: () => {},
      stderr: () => {},
      claudePort: fakeClaudePort({ loggedIn: true, identity: { email: "someone-else@example.com", orgName: "Other Org" } }),
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
      async version() {
        return "1.0.0 (Claude Code)";
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
      claudePort: fakeClaudePort({ loggedIn: true, identity: { email: "work@example.com", orgName: "Work Org" } }),
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
    const claudePort = fakeClaudePort({ loggedIn: true, identity: { email: "dev@example.com", orgName: "Acme Corp" } });

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
      claudePort: fakeClaudePort({ loggedIn: true, identity: { email: "work@example.com", orgName: "Work Org" } }),
    });
    await runCli(["use", "work"], {
      stateDir,
      stdout: () => {},
      stderr: () => {},
      claudePort: fakeClaudePort({ loggedIn: true, identity: { email: "someone-else@example.com", orgName: "Other Org" } }),
    });
    expect((await loadRegistry(stateDir)).profiles.work?.drifted).toBe(true);

    const { stdout, stderr, stdoutFn, stderrFn } = captureLines();
    const claudePort = fakeClaudePort({ loggedIn: true, identity: { email: "someone-else@example.com", orgName: "Other Org" } });

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
      claudePort: fakeClaudePort({ loggedIn: true, identity: { email: "work@example.com", orgName: "Work Org" } }),
    });
    await runCli(["login", "personal"], {
      env: {},
      stdout: () => {},
      stderr: () => {},
      stateDir,
      claudePort: fakeClaudePort({ loggedIn: true, identity: { email: "me@example.com", orgName: "Personal Org" } }),
    });

    const claudePort = fakeClaudePort({ loggedIn: true, identity: { email: "someone-else@example.com", orgName: "Other Org" } });
    const code = await runCli(["reconcile", "work"], { stateDir, stdout: () => {}, stderr: () => {}, claudePort });

    expect(code).toBe(0);
    const registry = await loadRegistry(stateDir);
    expect(registry.profiles.personal?.expectedIdentity).toEqual({ email: "me@example.com", orgName: "Personal Org" });
  });
});
