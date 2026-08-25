import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ClaudePort } from "../../src/claude-port.js";
import { runCli } from "../../src/cli.js";
import { addProfile, loadRegistry } from "../../src/registry.js";
import { SHELL_WIRING_LINE } from "../../src/shell-wiring.js";
import { captureLines, fakeClaudePort } from "./shared.js";

describe("runCli doctor", () => {
  let stateDir: string;
  let installDir: string;
  let legacyStateDir: string;
  let shellRcPath: string;
  let installStateFilePath: string;
  let fakeClaudeBinDir: string;

  beforeEach(async () => {
    stateDir = join(await mkdtemp(join(tmpdir(), "ccp-cli-doctor-test-")), "ccp");
    installDir = await mkdtemp(join(tmpdir(), "ccp-cli-doctor-install-"));
    const scratch = await mkdtemp(join(tmpdir(), "ccp-cli-doctor-scratch-"));
    legacyStateDir = join(scratch, "ccacct");
    shellRcPath = join(scratch, ".zshrc");
    installStateFilePath = join(scratch, ".claude.json");

    // "claude on PATH" (src/doctor.ts) only ever checks the executable bit, never spawns it (see
    // its own doc comment), so an empty file is enough to stand in for the real `claude` — same
    // spirit as ADR-0005's fake ClaudePort, applied to this one Check that reads env.PATH
    // directly instead of going through an injected port. Without this, whether "every Check
    // comes back clean" depends on the ambient machine actually having Claude Code installed,
    // which is true on a developer's Mac but not on a CI runner.
    fakeClaudeBinDir = await mkdtemp(join(tmpdir(), "ccp-cli-doctor-claude-bin-"));
    await writeFile(join(fakeClaudeBinDir, "claude"), "", { mode: 0o755 });
  });

  afterEach(async () => {
    await rm(stateDir, { recursive: true, force: true });
    await rm(installDir, { recursive: true, force: true });
    await rm(legacyStateDir, { recursive: true, force: true });
    await rm(fakeClaudeBinDir, { recursive: true, force: true });
  });

  function runDoctor(claudePort: ClaudePort = fakeClaudePort({ loggedIn: false })) {
    const { stdout, stderr, stdoutFn, stderrFn } = captureLines();
    return runCli(["doctor"], {
      env: { PATH: fakeClaudeBinDir },
      stateDir,
      installDir,
      installStateFilePath,
      legacyStateDir,
      shellRcPath,
      stdout: stdoutFn,
      stderr: stderrFn,
      claudePort,
    }).then((code) => ({ code, stdout, stderr }));
  }

  it("reports each Contract by name alongside what it found", async () => {
    const { code, stdout, stderr } = await runDoctor();

    expect(code).toBe(0);
    expect(stderr).toEqual([]);
    const report = stdout.join("\n");
    for (const contract of [
      "claude on PATH",
      "Claude Code version",
      "Default install",
      "Rig",
      "Onboarding pre-seeding",
      "State directory",
      "Legacy state directory",
      "Shell wiring",
      "Identity isolation",
      "Verified against",
    ]) {
      expect(report).toContain(`${contract}:`);
    }
  });

  it("reports the Claude Code version, read through the ClaudePort rather than a direct spawn", async () => {
    const { stdout } = await runDoctor(fakeClaudePort({ loggedIn: false }, { version: "2.1.224 (Claude Code)" }));

    expect(stdout.join("\n")).toMatch(/Claude Code version: 2\.1\.224 \(Claude Code\)/);
  });

  describe("Verified against (issue #34)", () => {
    const failingPort: ClaudePort = {
      async login() {},
      async authStatus() {
        return { loggedIn: false };
      },
      async version() {
        throw new Error("spawn claude ENOENT");
      },
    };

    /** Makes every other Check report `ok` — this describe block's own beforeEach already leaves
     * "Onboarding pre-seeding" and "Shell wiring" reporting a problem, and a version is only ever
     * recorded (per issue #34's "last **passed** against", not merely "ran against") on a run
     * where every Check comes back clean. */
    async function makeEveryOtherCheckClean(): Promise<void> {
      await writeFile(installStateFilePath, JSON.stringify({ hasCompletedOnboarding: true, lastOnboardingVersion: "1.0.0" }), "utf8");
      await writeFile(shellRcPath, `# .zshrc\n${SHELL_WIRING_LINE}\n`, "utf8");
    }

    it("records and reports the version once every Check comes back clean", async () => {
      await makeEveryOtherCheckClean();

      const { stdout } = await runDoctor(fakeClaudePort({ loggedIn: false }, { version: "2.1.224 (Claude Code)" }));

      expect(stdout.join("\n")).toContain("Verified against: 2.1.224 (Claude Code)");
    });

    it("never records a version from a run where a Check found a real problem — Onboarding pre-seeding and Shell wiring are unresolved by default here", async () => {
      const { stdout } = await runDoctor(fakeClaudePort({ loggedIn: false }, { version: "2.1.224 (Claude Code)" }));

      expect(stdout.join("\n")).toContain("Verified against: no version has ever been recorded on this machine");
    });

    it("never overwrites a clean record with a version from a later run that found a problem", async () => {
      await makeEveryOtherCheckClean();
      await runDoctor(fakeClaudePort({ loggedIn: false }, { version: "2.1.224 (Claude Code)" }));

      // Shell wiring now regresses (as if someone edited the .zshrc back out) — a real problem on
      // this later run — even though the version itself is unchanged.
      await writeFile(shellRcPath, "# .zshrc\n", "utf8");
      const { stdout } = await runDoctor(fakeClaudePort({ loggedIn: false }, { version: "2.1.224 (Claude Code)" }));

      expect(stdout.join("\n")).toContain("Shell wiring: missing");
      expect(stdout.join("\n")).toContain("Verified against: 2.1.224 (Claude Code)");
    });

    it("reports the previously recorded version when this run can't resolve a current one, rather than losing the record", async () => {
      await makeEveryOtherCheckClean();
      await runDoctor(fakeClaudePort({ loggedIn: false }, { version: "2.1.224 (Claude Code)" }));

      const { stdout } = await runDoctor(failingPort);

      expect(stdout.join("\n")).toContain("Verified against: 2.1.224 (Claude Code)");
    });

    it("reports that nothing has ever been recorded when a version has never been resolved on this machine", async () => {
      const { stdout } = await runDoctor(failingPort);

      expect(stdout.join("\n")).toContain("Verified against: no version has ever been recorded on this machine");
    });

    it("updates the record when the version changes between clean runs", async () => {
      await makeEveryOtherCheckClean();
      await runDoctor(fakeClaudePort({ loggedIn: false }, { version: "2.1.224 (Claude Code)" }));

      const { stdout } = await runDoctor(fakeClaudePort({ loggedIn: false }, { version: "2.2.0 (Claude Code)" }));

      expect(stdout.join("\n")).toContain("Verified against: 2.2.0 (Claude Code)");
    });

    it("writes exactly the recorded-version file once every Check comes back clean, and nothing more", async () => {
      await makeEveryOtherCheckClean();

      await runDoctor(fakeClaudePort({ loggedIn: false }, { version: "2.1.224 (Claude Code)" }));

      await expect(readdir(stateDir)).resolves.toEqual(["verified-version.json"]);
    });
  });

  it("detects a state directory under the pre-rename name and prints the single move command that resolves it", async () => {
    await mkdir(legacyStateDir, { recursive: true });

    const { stdout } = await runDoctor();

    expect(stdout.join("\n")).toContain(`Legacy state directory: found at ${legacyStateDir}`);
    expect(stdout.join("\n")).toContain(`mv ${legacyStateDir} ${stateDir}`);
    // Detection only — nothing was moved.
    await expect(stat(legacyStateDir)).resolves.toBeDefined();
  });

  it("detects missing shell wiring and prints the exact line to add", async () => {
    const { stdout } = await runDoctor();

    expect(stdout.join("\n")).toContain(`Shell wiring: missing from ${shellRcPath}`);
    expect(stdout.join("\n")).toContain(SHELL_WIRING_LINE);
  });

  it("reports shell wiring present once the exact line has been added", async () => {
    await writeFile(shellRcPath, `# .zshrc\n${SHELL_WIRING_LINE}\n`, "utf8");

    const { stdout } = await runDoctor();

    expect(stdout.join("\n")).toContain(`Shell wiring: present in ${shellRcPath}`);
  });

  it("writes nothing at all when a Check found a real problem, since there is nothing clean to record (issue #34)", async () => {
    // Populate every path doctor reads from, so every Check's "found" branch runs too, not just
    // the absent-state defaults which trivially write nothing — but leave three of them dirty
    // (an unrecognised Rig entry, a legacy state directory, missing Shell wiring), so this run
    // never qualifies to record a version (see the "Verified against" describe block above).
    await mkdir(join(installDir, "skills"));
    await writeFile(join(installDir, "unknown-thing"), "x", "utf8");
    const installState = JSON.stringify({ hasCompletedOnboarding: true, lastOnboardingVersion: "1.0.0" });
    await writeFile(installStateFilePath, installState, "utf8");
    await mkdir(legacyStateDir, { recursive: true });
    const zshrcContents = "# .zshrc\n";
    await writeFile(shellRcPath, zshrcContents, "utf8");

    const { code } = await runDoctor();

    expect(code).toBe(0);
    // The state directory, never created ahead of time, still doesn't exist — nothing was ever
    // recorded (asserted separately: the "Verified against" block above covers the one case where
    // it is written to).
    await expect(stat(stateDir)).rejects.toThrow();
    // Neither file doctor only ever reads was modified.
    await expect(readFile(installStateFilePath, "utf8")).resolves.toBe(installState);
    await expect(readFile(shellRcPath, "utf8")).resolves.toBe(zshrcContents);
    // The legacy directory is untouched — still there, never moved.
    await expect(stat(legacyStateDir)).resolves.toBeDefined();
  });

  it("lists 'doctor' in the usage text", async () => {
    const { stdout, stdoutFn, stderrFn } = captureLines();

    await runCli([], { stdout: stdoutFn, stderr: stderrFn });

    expect(stdout.join("\n")).toMatch(/doctor/);
  });
});

describe("runCli setup (issue #35)", () => {
  let stateDir: string;
  let installDir: string;
  let legacyStateDir: string;
  let shellRcPath: string;
  let installStateFilePath: string;

  beforeEach(async () => {
    stateDir = join(await mkdtemp(join(tmpdir(), "ccp-cli-setup-test-")), "ccp");
    installDir = await mkdtemp(join(tmpdir(), "ccp-cli-setup-install-"));
    const scratch = await mkdtemp(join(tmpdir(), "ccp-cli-setup-scratch-"));
    legacyStateDir = join(scratch, "ccacct");
    shellRcPath = join(scratch, ".zshrc");
    installStateFilePath = join(scratch, ".claude.json");
    // Every Check but the two fatal ones ("claude on PATH", "State directory") starts dirty by
    // default in this suite's fixtures (no onboarding state, no Rig contents, an absent legacy
    // directory reports clean though) — deliberate, so a passing exit code here is provably about
    // the fatal/non-fatal rule and not an accident of every Check happening to be clean.
  });

  afterEach(async () => {
    await rm(stateDir, { recursive: true, force: true });
    await rm(installDir, { recursive: true, force: true });
    await rm(legacyStateDir, { recursive: true, force: true });
  });

  /** `claude` on `PATH` by default — most cases here are about the *shell wiring* write, not the
   * fatal/non-fatal rule, which gets its own describe block below with `PATH` deliberately empty
   * or non-empty as each case needs. */
  function binDirOnPath(): Promise<string> {
    return mkdtemp(join(tmpdir(), "ccp-cli-setup-bin-")).then(async (binDir) => {
      const claudePath = join(binDir, "claude");
      await writeFile(claudePath, "#!/bin/sh\n", "utf8");
      await chmod(claudePath, 0o755);
      return binDir;
    });
  }

  function runSetup(args: string[] = [], overrides: { env?: NodeJS.ProcessEnv; claudePort?: ClaudePort } = {}) {
    const { stdout, stderr, stdoutFn, stderrFn } = captureLines();
    return runCli(["setup", ...args], {
      env: overrides.env ?? { PATH: "" },
      stateDir,
      installDir,
      installStateFilePath,
      legacyStateDir,
      shellRcPath,
      claudePort: overrides.claudePort ?? fakeClaudePort({ loggedIn: false }),
      stdout: stdoutFn,
      stderr: stderrFn,
    }).then((code) => ({ code, stdout, stderr }));
  }

  it("writes the guarded line to a file that lacks it, and reports the file and the exact line", async () => {
    await writeFile(shellRcPath, "# my zshrc\n", "utf8");
    const binDir = await binDirOnPath();

    const { code, stdout } = await runSetup([], { env: { PATH: binDir } });

    expect(code).toBe(0);
    expect(await readFile(shellRcPath, "utf8")).toBe(`# my zshrc\n${SHELL_WIRING_LINE}\n`);
    const report = stdout.join("\n");
    expect(report).toContain(shellRcPath);
    expect(report).toContain(SHELL_WIRING_LINE);
  });

  it("writes nothing to the file on a second run — idempotent", async () => {
    const binDir = await binDirOnPath();
    await runSetup([], { env: { PATH: binDir } });
    const afterFirstRun = await readFile(shellRcPath, "utf8");

    const { code, stdout } = await runSetup([], { env: { PATH: binDir } });

    expect(code).toBe(0);
    expect(await readFile(shellRcPath, "utf8")).toBe(afterFirstRun);
    expect(stdout.join("\n")).toMatch(/already contains the shell wiring line/i);
  });

  it("honours the zsh dot-directory environment variable in preference to the home directory", async () => {
    const zdotdir = await mkdtemp(join(tmpdir(), "ccp-cli-setup-zdotdir-"));
    const binDir = await binDirOnPath();
    const { stdout, stderr, stdoutFn, stderrFn } = captureLines();

    try {
      const code = await runCli(["setup"], {
        // $SHELL must name zsh for $ZDOTDIR to apply at all (issue #40) — every other $SHELL
        // resolves to ~/.bashrc regardless of $ZDOTDIR, covered separately below.
        env: { PATH: binDir, SHELL: "/usr/bin/zsh", ZDOTDIR: zdotdir },
        stateDir,
        installDir,
        installStateFilePath,
        legacyStateDir,
        claudePort: fakeClaudePort({ loggedIn: false }),
        stdout: stdoutFn,
        stderr: stderrFn,
      });

      expect(code).toBe(0);
      expect(await readFile(join(zdotdir, ".zshrc"), "utf8")).toContain(SHELL_WIRING_LINE);
      expect(stdout.join("\n")).toContain(join(zdotdir, ".zshrc"));
      expect(stderr).toEqual([]);
    } finally {
      await rm(zdotdir, { recursive: true, force: true });
    }
  });

  it("dry run prints the line instead of writing it", async () => {
    const { code, stdout } = await runSetup(["--dry-run"]);

    expect(code).toBe(0);
    expect(stdout.join("\n")).toContain(SHELL_WIRING_LINE);
    await expect(stat(shellRcPath)).rejects.toThrow();
  });

  it("dry run reports there is nothing to add when the line is already present", async () => {
    await writeFile(shellRcPath, `# my zshrc\n${SHELL_WIRING_LINE}\n`, "utf8");
    const before = await readFile(shellRcPath, "utf8");

    const { code, stdout } = await runSetup(["--dry-run"]);

    expect(code).toBe(0);
    expect(stdout.join("\n")).toMatch(/already contains/i);
    expect(await readFile(shellRcPath, "utf8")).toBe(before);
  });

  it("runs the same Checks `ccp doctor` exposes and reports every Contract by name", async () => {
    const binDir = await binDirOnPath();

    const { stdout } = await runSetup([], { env: { PATH: binDir } });

    const report = stdout.join("\n");
    for (const contract of [
      "claude on PATH",
      "Claude Code version",
      "Default install",
      "Rig",
      "Onboarding pre-seeding",
      "State directory",
      "Legacy state directory",
      "Shell wiring",
      "Identity isolation",
    ]) {
      expect(report).toContain(`${contract}:`);
    }
    // Shell wiring now reports present, since the write above ran before the Checks did.
    expect(report).toContain(`Shell wiring: present in ${shellRcPath}`);
  });

  it("ends by naming the next command to run, on success", async () => {
    const binDir = await binDirOnPath();

    const { stdout } = await runSetup([], { env: { PATH: binDir } });

    expect(stdout.join("\n")).toMatch(/ccp add/);
  });

  describe("the fatal/non-fatal rule", () => {
    it("fails when `claude` is not on PATH", async () => {
      const { code, stdout } = await runSetup([], { env: { PATH: "" } });

      expect(code).toBe(1);
      expect(stdout.join("\n")).toContain("claude on PATH: not found");
      // A missing `claude` is fatal, so the *success* next-command line never appears — but Setup
      // still ends by naming a next command either way (this ticket's own acceptance criteria):
      // fix the problem, then re-run `ccp setup`.
      expect(stdout.join("\n")).not.toMatch(/ccp add/);
      expect(stdout.join("\n")).toMatch(/Next:.*re-run 'ccp setup'/);
    });

    it("fails when the state directory is not writable", async () => {
      const binDir = await binDirOnPath();
      const unwritableParent = await mkdtemp(join(tmpdir(), "ccp-cli-setup-unwritable-"));
      const unwritableStateDir = join(unwritableParent, "ccp");
      await chmod(unwritableParent, 0o500);

      try {
        const { stdout, stdoutFn, stderrFn } = captureLines();
        const code = await runCli(["setup"], {
          env: { PATH: binDir },
          stateDir: unwritableStateDir,
          installDir,
          installStateFilePath,
          legacyStateDir,
          shellRcPath,
          claudePort: fakeClaudePort({ loggedIn: false }),
          stdout: stdoutFn,
          stderr: stderrFn,
        });

        expect(code).toBe(1);
        expect(stdout.join("\n")).toMatch(/State directory: .*not writable/i);
        expect(stdout.join("\n")).toMatch(/Next:.*re-run 'ccp setup'/);
      } finally {
        await chmod(unwritableParent, 0o700);
        await rm(unwritableParent, { recursive: true, force: true });
      }
    });

    it("succeeds despite an absent Default install — reported, never fatal", async () => {
      const binDir = await binDirOnPath();
      const missingInstallDir = join(installDir, "does-not-exist");

      const { stdout, stdoutFn, stderrFn } = captureLines();
      const code = await runCli(["setup"], {
        env: { PATH: binDir },
        stateDir,
        installDir: missingInstallDir,
        installStateFilePath,
        legacyStateDir,
        shellRcPath,
        claudePort: fakeClaudePort({ loggedIn: false }),
        stdout: stdoutFn,
        stderr: stderrFn,
      });

      expect(code).toBe(0);
      expect(stdout.join("\n")).toMatch(/Default install: not found/i);
      expect(stdout.join("\n")).toMatch(/ccp add/);
    });

    it("succeeds despite the Claude Code version failing to resolve — an unrecognised identity output shape is reported, never fatal", async () => {
      const binDir = await binDirOnPath();
      const throwingPort: ClaudePort = {
        async login() {},
        async authStatus() {
          return { loggedIn: false };
        },
        async version() {
          throw new Error("unexpected --version output shape");
        },
      };

      const { code, stdout } = await runSetup([], { env: { PATH: binDir }, claudePort: throwingPort });

      expect(code).toBe(0);
      expect(stdout.join("\n")).toMatch(/Claude Code version: could not be determined/i);
      expect(stdout.join("\n")).toMatch(/ccp add/);
    });
  });

  it("lists 'setup' and the '--dry-run' flag in the usage text", async () => {
    const { stdout, stdoutFn, stderrFn } = captureLines();

    await runCli([], { stdout: stdoutFn, stderr: stderrFn });

    expect(stdout.join("\n")).toMatch(/setup/);
    expect(stdout.join("\n")).toMatch(/--dry-run/);
  });
});

describe("runCli teardown (issue #35)", () => {
  let stateDir: string;
  let scratch: string;
  let shellRcPath: string;

  beforeEach(async () => {
    stateDir = join(await mkdtemp(join(tmpdir(), "ccp-cli-teardown-test-")), "ccp");
    scratch = await mkdtemp(join(tmpdir(), "ccp-cli-teardown-scratch-"));
    shellRcPath = join(scratch, ".zshrc");
  });

  afterEach(async () => {
    await rm(stateDir, { recursive: true, force: true });
    await rm(scratch, { recursive: true, force: true });
  });

  function runTeardown() {
    const { stdout, stderr, stdoutFn, stderrFn } = captureLines();
    return runCli(["teardown"], { stateDir, shellRcPath, stdout: stdoutFn, stderr: stderrFn }).then((code) => ({
      code,
      stdout,
      stderr,
    }));
  }

  it("removes the line Setup added, leaving unrelated content in the file untouched", async () => {
    await writeFile(shellRcPath, `# before\nexport FOO=bar\n${SHELL_WIRING_LINE}\n# after\n`, "utf8");

    const { code, stdout } = await runTeardown();

    expect(code).toBe(0);
    expect(await readFile(shellRcPath, "utf8")).toBe("# before\nexport FOO=bar\n# after\n");
    expect(stdout.join("\n")).toMatch(/removed/i);
  });

  it("is safe to run when no line is present", async () => {
    const contents = "# my zshrc, never wired up\n";
    await writeFile(shellRcPath, contents, "utf8");

    const { code, stdout } = await runTeardown();

    expect(code).toBe(0);
    expect(await readFile(shellRcPath, "utf8")).toBe(contents);
    expect(stdout.join("\n")).toMatch(/nothing to do/i);
  });

  it("is safe to run when the startup file doesn't exist at all", async () => {
    const { code } = await runTeardown();

    expect(code).toBe(0);
    await expect(stat(shellRcPath)).rejects.toThrow();
  });

  it("reports what it deliberately left behind, naming the state directory and the per-Profile removal command — it never touches Profiles", async () => {
    await writeFile(shellRcPath, `${SHELL_WIRING_LINE}\n`, "utf8");
    await mkdir(stateDir, { recursive: true });
    await addProfile(stateDir, "work", await mkdtemp(join(tmpdir(), "ccp-cli-teardown-install-")));

    const { stdout } = await runTeardown();

    const report = stdout.join("\n");
    expect(report).toContain(stateDir);
    expect(report).toMatch(/ccp rm/);
    // Never touched: the Profile registered above is still there afterwards.
    const { profiles } = await loadRegistry(stateDir);
    expect(profiles.work).toBeDefined();
  });

  it("lists 'teardown' in the usage text", async () => {
    const { stdout, stdoutFn, stderrFn } = captureLines();

    await runCli([], { stdout: stdoutFn, stderr: stderrFn });

    expect(stdout.join("\n")).toMatch(/teardown/);
  });
});
