import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ClaudePort } from "../src/claude-port.js";
import { LEGACY_STATE_DIR_NAME, runDoctorChecks, SHELL_WIRING_LINE, type DoctorContext } from "../src/doctor.js";

function fakeClaudePort(version: string | Error = "2.1.224 (Claude Code)"): ClaudePort {
  return {
    async login() {},
    async authStatus() {
      return { loggedIn: false };
    },
    async version() {
      if (version instanceof Error) throw version;
      return version;
    },
  };
}

async function findReport(reports: Awaited<ReturnType<typeof runDoctorChecks>>, contract: string) {
  const report = reports.find((r) => r.contract === contract);
  expect(report).toBeDefined();
  return report!.finding;
}

describe("runDoctorChecks", () => {
  let root: string;
  let installDir: string;
  let stateDir: string;
  let legacyStateDir: string;
  let zshrcPath: string;
  let installStateFilePath: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "ccp-doctor-test-"));
    installDir = join(root, "install");
    // Parent (`root`) always exists (mkdtemp), `stateDir` itself deliberately doesn't — mirrors a
    // machine that's never run `ccp add`/`ccp login` yet.
    stateDir = join(root, "ccp");
    legacyStateDir = join(root, "legacy-ccacct");
    zshrcPath = join(root, ".zshrc");
    installStateFilePath = join(root, ".claude.json");
    await mkdir(installDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  function context(overrides: Partial<DoctorContext> = {}): DoctorContext {
    return {
      env: { PATH: "" },
      claudePort: fakeClaudePort(),
      stateDir,
      installDir,
      installStateFilePath,
      legacyStateDir,
      zshrcPath,
      ...overrides,
    };
  }

  it("reports every Contract by name", async () => {
    const reports = await runDoctorChecks(context());

    expect(reports.map((r) => r.contract)).toEqual([
      "claude on PATH",
      "Claude Code version",
      "Default install",
      "Rig",
      "Onboarding pre-seeding",
      "State directory",
      "Legacy state directory",
      "Shell wiring",
    ]);
  });

  describe("claude on PATH", () => {
    it("reports found when an executable named `claude` is on PATH", async () => {
      const binDir = join(root, "bin");
      await mkdir(binDir);
      const claudePath = join(binDir, "claude");
      await writeFile(claudePath, "#!/bin/sh\n", "utf8");
      await chmod(claudePath, 0o755);

      const reports = await runDoctorChecks(context({ env: { PATH: binDir } }));

      expect(await findReport(reports, "claude on PATH")).toMatch(/found/i);
    });

    it("reports not found when no directory on PATH has an executable `claude`", async () => {
      const emptyDir = join(root, "empty-bin");
      await mkdir(emptyDir);

      const reports = await runDoctorChecks(context({ env: { PATH: emptyDir } }));

      expect(await findReport(reports, "claude on PATH")).toMatch(/not found/i);
    });
  });

  describe("Claude Code version", () => {
    it("reports the version the port resolves", async () => {
      const reports = await runDoctorChecks(context({ claudePort: fakeClaudePort("2.1.224 (Claude Code)") }));

      expect(await findReport(reports, "Claude Code version")).toBe("2.1.224 (Claude Code)");
    });

    it("reports the failure to resolve one, rather than aborting the rest of the report", async () => {
      const reports = await runDoctorChecks(context({ claudePort: fakeClaudePort(new Error("spawn claude ENOENT")) }));

      expect(await findReport(reports, "Claude Code version")).toMatch(/could not be determined.*ENOENT/i);
      // Every other Check still ran.
      expect(reports).toHaveLength(8);
    });
  });

  describe("Default install", () => {
    it("reports found when the Default install directory exists", async () => {
      const reports = await runDoctorChecks(context());

      expect(await findReport(reports, "Default install")).toMatch(new RegExp(`found at ${installDir}`));
    });

    it("reports absent, naming the consequence, when it doesn't exist", async () => {
      const missingInstallDir = join(root, "no-such-install");

      const reports = await runDoctorChecks(context({ installDir: missingInstallDir }));

      expect(await findReport(reports, "Default install")).toMatch(/not found.*empty Rig.*no onboarding pre-seeding/i);
    });

    it("reports a real error distinctly from 'not found', rather than misreporting it as absent", async () => {
      // A path through a plain file, not a directory, throws ENOTDIR — a real error, unlike the
      // ordinary ENOENT an absent Default install produces above.
      const notADir = join(root, "not-a-directory");
      await writeFile(notADir, "x", "utf8");

      const reports = await runDoctorChecks(context({ installDir: join(notADir, "child") }));

      expect(await findReport(reports, "Default install")).toMatch(/could not be checked/i);
    });
  });

  describe("Rig", () => {
    it("names an entry present in the Default install that is not a known Rig item", async () => {
      await mkdir(join(installDir, "skills"));
      await writeFile(join(installDir, "some-new-thing"), "", "utf8");

      const reports = await runDoctorChecks(context());

      expect(await findReport(reports, "Rig")).toMatch(/unrecognised.*some-new-thing/i);
    });

    it("stays silent when everything under the Default install is a known Rig item", async () => {
      await mkdir(join(installDir, "skills"));
      await writeFile(join(installDir, "CLAUDE.md"), "# Instructions", "utf8");

      const reports = await runDoctorChecks(context());

      expect(await findReport(reports, "Rig")).not.toMatch(/unrecognised/i);
    });

    it("is unbothered by known Rig items that are absent from the Default install", async () => {
      // Only one of the six Rig items exists. Their absence — ordinary, already-established
      // behaviour (Spike 0001, ADR-0007) — must never be reported; only unrecognised *presence*.
      await mkdir(join(installDir, "skills"));

      const reports = await runDoctorChecks(context());

      expect(await findReport(reports, "Rig")).not.toMatch(/unrecognised/i);
    });

    it("reports a real error distinctly from 'skipped', rather than misreporting it as an absent Default install", async () => {
      const notADir = join(root, "not-a-directory-4");
      await writeFile(notADir, "x", "utf8");

      const reports = await runDoctorChecks(context({ installDir: join(notADir, "child") }));

      expect(await findReport(reports, "Rig")).toMatch(/could not be checked/i);
    });
  });

  describe("Onboarding pre-seeding", () => {
    it("reports it would currently work once the Default install has completed onboarding", async () => {
      await writeFile(installStateFilePath, JSON.stringify({ hasCompletedOnboarding: true, lastOnboardingVersion: "2.1.221" }), "utf8");

      const reports = await runDoctorChecks(context());

      expect(await findReport(reports, "Onboarding pre-seeding")).toMatch(/would currently work/i);
    });

    it("reports it would not currently work when the Default install hasn't completed onboarding itself yet", async () => {
      const reports = await runDoctorChecks(context());

      expect(await findReport(reports, "Onboarding pre-seeding")).toMatch(/would not currently work/i);
    });
  });

  describe("State directory", () => {
    it("reports writable when it already exists with write permission", async () => {
      await mkdir(stateDir, { recursive: true });

      const reports = await runDoctorChecks(context());

      expect(await findReport(reports, "State directory")).toMatch(/writable/i);
    });

    it("reports that it doesn't exist yet but will be created on first use, when its parent is writable", async () => {
      // stateDir itself was never created by beforeEach, but its parent (root/state) is.
      const reports = await runDoctorChecks(context());

      expect(await findReport(reports, "State directory")).toMatch(/does not exist yet.*parent directory is writable/i);
    });
  });

  describe("Legacy state directory", () => {
    it("detects a directory under the pre-rename name and prints the single move command that resolves it", async () => {
      await mkdir(legacyStateDir, { recursive: true });

      const reports = await runDoctorChecks(context());

      expect(await findReport(reports, "Legacy state directory")).toBe(`found at ${legacyStateDir}, from before the rename (issue #31) — resolve it with: mv ${legacyStateDir} ${stateDir}`);
    });

    it("reports none found when no directory exists under the pre-rename name", async () => {
      const reports = await runDoctorChecks(context());

      expect(await findReport(reports, "Legacy state directory")).toBe("none found");
    });

    it("uses the pre-rename name '.ccacct'", () => {
      expect(LEGACY_STATE_DIR_NAME).toBe(".ccacct");
    });

    it("reports a real error distinctly from 'none found', rather than misreporting it as absent", async () => {
      const notADir = join(root, "not-a-directory-2");
      await writeFile(notADir, "x", "utf8");

      const reports = await runDoctorChecks(context({ legacyStateDir: join(notADir, "child") }));

      expect(await findReport(reports, "Legacy state directory")).toMatch(/could not be checked/i);
    });
  });

  describe("Shell wiring", () => {
    it("detects the guarded line when present", async () => {
      await writeFile(zshrcPath, `# my zshrc\n${SHELL_WIRING_LINE}\n`, "utf8");

      const reports = await runDoctorChecks(context());

      expect(await findReport(reports, "Shell wiring")).toMatch(new RegExp(`present in ${zshrcPath}`));
    });

    it("prints the exact line to add when the file has no shell wiring at all", async () => {
      await writeFile(zshrcPath, "# my zshrc\n", "utf8");

      const reports = await runDoctorChecks(context());

      expect(await findReport(reports, "Shell wiring")).toContain(SHELL_WIRING_LINE);
    });

    it("prints the exact line to add when the startup file doesn't exist at all", async () => {
      const reports = await runDoctorChecks(context());

      expect(await findReport(reports, "Shell wiring")).toContain(SHELL_WIRING_LINE);
    });

    it("reports a real error distinctly from 'missing', rather than misreporting it as an absent line", async () => {
      const notADir = join(root, "not-a-directory-3");
      await writeFile(notADir, "x", "utf8");

      const reports = await runDoctorChecks(context({ zshrcPath: join(notADir, "child") }));

      expect(await findReport(reports, "Shell wiring")).toMatch(/could not be checked/i);
    });
  });

  it("never writes anything to disk, for any Check, in any state — asserted directly, not assumed", async () => {
    // Deliberately exercise every "found" branch too, not just the absent-state defaults.
    await mkdir(join(installDir, "skills"));
    await writeFile(join(installDir, "unknown-thing"), "x", "utf8");
    const installStateContents = JSON.stringify({ hasCompletedOnboarding: true, lastOnboardingVersion: "1.0.0" });
    await writeFile(installStateFilePath, installStateContents, "utf8");
    await mkdir(legacyStateDir, { recursive: true });
    const zshrcContents = "# my zshrc\n";
    await writeFile(zshrcPath, zshrcContents, "utf8");

    const installEntriesBefore = (await readdir(installDir)).sort();

    await runDoctorChecks(context());

    // The state directory, never created ahead of time, still doesn't exist.
    await expect(stat(stateDir)).rejects.toThrow();
    // The legacy directory is still there, untouched — detection, never migration.
    expect((await stat(legacyStateDir)).isDirectory()).toBe(true);
    // Nothing under the Default install was added, removed, or changed.
    expect((await readdir(installDir)).sort()).toEqual(installEntriesBefore);
    // Neither file Checks only ever read was modified.
    await expect(readFile(installStateFilePath, "utf8")).resolves.toBe(installStateContents);
    await expect(readFile(zshrcPath, "utf8")).resolves.toBe(zshrcContents);
  });
});
