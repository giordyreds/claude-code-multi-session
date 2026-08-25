import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ClaudePort } from "../../src/claude-port.js";
import { runCli } from "../../src/cli.js";
import type { CommandRunner } from "../../src/command-runner.js";
import type { Picker, PickerRow } from "../../src/picker.js";
import { addProfile, loadRegistry } from "../../src/registry.js";
import { captureLines, fakeClaudePort, throwingClaudePort } from "./shared.js";

/** A fake {@link Picker}: hands `select` every row it was shown and returns whatever `select`
 * decides — a chosen Alias, or `undefined` to simulate cancelling. Used only by `runCli use`
 * below, so it lives here rather than in `./shared.js` (ADR-0015's single-caller rule). */
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
 * process. Used only by `runCli run` below, so it lives here rather than in `./shared.js`
 * (ADR-0015's single-caller rule). */
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

describe("runCli shell-init", () => {
  it("prints shell/ccp.sh's exact contents to stdout and nothing else", async () => {
    const { stdout, stderr, stdoutFn, stderrFn } = captureLines();
    const script = await readFile(new URL("../../shell/ccp.sh", import.meta.url), "utf8");

    const code = await runCli(["shell-init"], { stdout: stdoutFn, stderr: stderrFn });

    expect(code).toBe(0);
    // Bare — shell/ccp.sh stays the single source of truth (ADR-0004's Amendment 1); this reads
    // and prints it rather than duplicating its text into the program.
    expect(stdout).toEqual([script]);
    expect(stderr).toEqual([]);
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
    const claudePort = fakeClaudePort({ loggedIn: true, identity: { email: "dev@example.com", orgName: "Acme Corp" } });

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
      claudePort: fakeClaudePort({ loggedIn: true, identity: { email: "work@example.com", orgName: "Work Org" } }),
    });
    const { configDir } = (await loadRegistry(stateDir)).profiles.work!;

    const { stdout, stderr, stdoutFn, stderrFn } = captureLines();
    const claudePort = fakeClaudePort({ loggedIn: true, identity: { email: "work@example.com", orgName: "Work Org" } });

    const code = await runCli(["use", "work"], { stateDir, stdout: stdoutFn, stderr: stderrFn, claudePort });

    expect(code).toBe(0);
    expect(stderr).toEqual([]);
    expect(stdout).toEqual([`export CLAUDE_CONFIG_DIR='${configDir}'`]);
    expect(claudePort.calls).toEqual([configDir]);
    // Never authenticates or opens a browser (CONTEXT.md's Binding, distinct from Login).
    expect(claudePort.loginCalls).toEqual([]);
  });

  it("spawns claude exactly once, asserted directly rather than assumed — never once per registered Profile (issue #34)", async () => {
    const installDir = await mkdtemp(join(tmpdir(), "ccp-cli-use-spawn-count-install-"));
    try {
      await runCli(["login", "work"], {
        env: {},
        stdout: () => {},
        stderr: () => {},
        stateDir,
        installDir,
        claudePort: fakeClaudePort({ loggedIn: true, identity: { email: "work@example.com", orgName: "Work Org" } }),
      });
      // Two more registered Profiles besides the one being bound — the identity isolation Check
      // (`ccp doctor`, never `ccp use`) is the only Check allowed to spawn once per Profile; this
      // asserts Binding itself never does, regardless of how many Profiles are registered.
      await addProfile(stateDir, "personal", installDir);
      await addProfile(stateDir, "side-project", installDir);
      const { configDir } = (await loadRegistry(stateDir)).profiles.work!;

      const claudePort = fakeClaudePort({ loggedIn: true, identity: { email: "work@example.com", orgName: "Work Org" } });

      const code = await runCli(["use", "work"], { stateDir, stdout: () => {}, stderr: () => {}, claudePort });

      expect(code).toBe(0);
      expect(claudePort.calls).toEqual([configDir]);
    } finally {
      await rm(installDir, { recursive: true, force: true });
    }
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
      claudePort: fakeClaudePort({ loggedIn: true, identity: { email: "work@example.com", orgName: "Work Org" } }),
    });
    const { configDir } = (await loadRegistry(stateDir)).profiles.work!;

    const { stdout, stderr, stdoutFn, stderrFn } = captureLines();
    const claudePort = fakeClaudePort({ loggedIn: true, identity: { email: "someone-else@example.com", orgName: "Other Org" } });

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
      claudePort: fakeClaudePort({ loggedIn: true, identity: { email: "work@example.com", orgName: "Work Org" } }),
    });
    await runCli(["use", "work"], {
      stateDir,
      stdout: () => {},
      stderr: () => {},
      claudePort: fakeClaudePort({ loggedIn: true, identity: { email: "drifted@example.com", orgName: "Drifted Org" } }),
    });
    expect((await loadRegistry(stateDir)).profiles.work?.drifted).toBe(true);

    const { stderr, stderrFn } = captureLines();
    const code = await runCli(["use", "work"], {
      stateDir,
      stdout: () => {},
      stderr: stderrFn,
      claudePort: fakeClaudePort({ loggedIn: true, identity: { email: "work@example.com", orgName: "Work Org" } }),
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
      claudePort: fakeClaudePort({ loggedIn: true, identity: { email: "work@example.com", orgName: "Work Org" } }),
    });
    await runCli(["use", "work"], {
      stateDir,
      stdout: () => {},
      stderr: () => {},
      claudePort: fakeClaudePort({ loggedIn: true, identity: { email: "drifted@example.com", orgName: "Drifted Org" } }),
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

  it("leaves a previously recorded Drift untouched when claude reports logged-in but identity: null — nothing was observed to disprove it (issue #48)", async () => {
    // Distinct code path from the logged-out regression test above: here `status.loggedIn` is
    // `true`, so `reportDriftAndUpdateRegistry` only stays a no-op because `compareToExpected`
    // reports `comparable: false` for a null observed identity. Collapsing that into
    // `drifted: false` instead — the exact bug a boolean-returning comparison would reintroduce —
    // would silently clear this Profile's recorded Drift.
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
      claudePort: fakeClaudePort({ loggedIn: true, identity: { email: "drifted@example.com", orgName: "Drifted Org" } }),
    });
    expect((await loadRegistry(stateDir)).profiles.work?.drifted).toBe(true);

    const { stderr, stderrFn } = captureLines();
    const code = await runCli(["use", "work"], {
      stateDir,
      stdout: () => {},
      stderr: stderrFn,
      claudePort: fakeClaudePort({ loggedIn: true, identity: null }),
    });

    expect(code).toBe(0);
    expect(stderr).toEqual([]);
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
        if (configDir === workDir) return { loggedIn: true, identity: { email: "work@example.com", orgName: "Work Org" } };
        if (configDir === personalDir) return { loggedIn: false };
        throw new Error(`unexpected configDir '${configDir}'`);
      },
      async version() {
        return "1.0.0 (Claude Code)";
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
        return { loggedIn: true, identity: { email: `${configDir === workDir ? "work" : "personal"}@example.com`, orgName: "Org" } };
      },
      async version() {
        return "1.0.0 (Claude Code)";
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
    const claudePort = fakeClaudePort({ loggedIn: true, identity: { email: "work@example.com", orgName: "Work Org" } });
    const picker = fakePicker(() => "work");

    const code = await runCli(["use"], { stateDir, stdout: stdoutFn, stderr: stderrFn, claudePort, picker });

    expect(code).toBe(0);
    expect(stderr).toEqual([]);
    expect(stdout).toEqual([`export CLAUDE_CONFIG_DIR='${configDir}'`]);
  });

  it("leaves the shell unchanged when the picker is cancelled", async () => {
    await addProfile(stateDir, "work", installDir);
    const { stdout, stderr, stdoutFn, stderrFn } = captureLines();
    const claudePort = fakeClaudePort({ loggedIn: true, identity: { email: "work@example.com", orgName: "Work Org" } });
    const picker = fakePicker(() => undefined);

    const code = await runCli(["use"], { stateDir, stdout: stdoutFn, stderr: stderrFn, claudePort, picker });

    expect(code).toBe(1);
    expect(stdout).toEqual([]);
  });

  it("fails with a clear message, without invoking the picker, when no Profiles are registered", async () => {
    const { stdout, stderr, stdoutFn, stderrFn } = captureLines();
    const claudePort = fakeClaudePort({ loggedIn: true, identity: null });
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
    const claudePort = fakeClaudePort({ loggedIn: true, identity: null });
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
    const claudePort = fakeClaudePort({ loggedIn: true, identity: { email: "work@example.com", orgName: "Work Org" } });

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
