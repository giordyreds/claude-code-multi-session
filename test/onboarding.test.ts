import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { seedOnboardingState } from "../src/onboarding.js";

describe("seedOnboardingState", () => {
  let installStateFilePath: string;
  let configDir: string;

  beforeEach(async () => {
    // A full file path, deliberately *not* nested under any "install directory" — the Default
    // install's real `.claude.json` is a sibling of `~/.claude`, not a child of it (see
    // src/cli.ts's `defaultInstallStateFilePath`), so the fixture mirrors that shape rather than
    // implying a nesting relationship that doesn't exist.
    const installScratchDir = await mkdtemp(join(tmpdir(), "ccp-onboarding-install-"));
    installStateFilePath = join(installScratchDir, ".claude.json");
    configDir = await mkdtemp(join(tmpdir(), "ccp-onboarding-profile-"));
  });

  afterEach(async () => {
    await rm(installStateFilePath, { force: true });
    await rm(configDir, { recursive: true, force: true });
  });

  async function writeInstallState(fields: Record<string, unknown>): Promise<void> {
    await writeFile(installStateFilePath, JSON.stringify(fields), "utf8");
  }

  async function writeProfileState(fields: Record<string, unknown>): Promise<void> {
    await writeFile(join(configDir, ".claude.json"), JSON.stringify(fields), "utf8");
  }

  async function readProfileState(): Promise<Record<string, unknown>> {
    return JSON.parse(await readFile(join(configDir, ".claude.json"), "utf8"));
  }

  it("copies hasCompletedOnboarding and lastOnboardingVersion from the Default install", async () => {
    await writeInstallState({ hasCompletedOnboarding: true, lastOnboardingVersion: "2.1.221" });
    await writeProfileState({ oauthAccount: { emailAddress: "work@example.com" } });

    const result = await seedOnboardingState(installStateFilePath, configDir);

    expect(result).toEqual({ seeded: true });
    expect(await readProfileState()).toEqual({
      oauthAccount: { emailAddress: "work@example.com" },
      hasCompletedOnboarding: true,
      lastOnboardingVersion: "2.1.221",
    });
  });

  it("copies a stale lastOnboardingVersion verbatim — verified by probe (ADR-0008) that Claude Code doesn't compare it against the running build", async () => {
    await writeInstallState({ hasCompletedOnboarding: true, lastOnboardingVersion: "1.0.0" });
    await writeProfileState({});

    const result = await seedOnboardingState(installStateFilePath, configDir);

    expect(result).toEqual({ seeded: true });
    expect(await readProfileState()).toMatchObject({ lastOnboardingVersion: "1.0.0" });
  });

  it("does nothing when the Default install has no '.claude.json' at all", async () => {
    await writeProfileState({});

    const result = await seedOnboardingState(installStateFilePath, configDir);

    expect(result.seeded).toBe(false);
    expect(await readProfileState()).toEqual({});
  });

  it("does nothing when the Default install hasn't completed onboarding itself yet", async () => {
    await writeInstallState({ hasCompletedOnboarding: false });
    await writeProfileState({});

    const result = await seedOnboardingState(installStateFilePath, configDir);

    expect(result.seeded).toBe(false);
    expect(await readProfileState()).toEqual({});
  });

  it("does nothing when the Default install's '.claude.json' is not valid JSON — never blocks Login over Claude Code's own file", async () => {
    await writeFile(installStateFilePath, "{not json", "utf8");
    await writeProfileState({});

    const result = await seedOnboardingState(installStateFilePath, configDir);

    expect(result.seeded).toBe(false);
    expect(await readProfileState()).toEqual({});
  });

  it("does nothing when the Default install's lastOnboardingVersion isn't a string", async () => {
    await writeInstallState({ hasCompletedOnboarding: true, lastOnboardingVersion: 221 });
    await writeProfileState({});

    const result = await seedOnboardingState(installStateFilePath, configDir);

    expect(result.seeded).toBe(false);
    expect(await readProfileState()).toEqual({});
  });

  it("does nothing when the Profile's own '.claude.json' doesn't exist yet, rather than fabricating one", async () => {
    await writeInstallState({ hasCompletedOnboarding: true, lastOnboardingVersion: "2.1.221" });

    const result = await seedOnboardingState(installStateFilePath, configDir);

    expect(result.seeded).toBe(false);
    await expect(readFile(join(configDir, ".claude.json"), "utf8")).rejects.toThrow();
  });

  it("is idempotent: does nothing when the Profile has already completed onboarding", async () => {
    await writeInstallState({ hasCompletedOnboarding: true, lastOnboardingVersion: "2.1.221" });
    await writeProfileState({ hasCompletedOnboarding: true, lastOnboardingVersion: "2.1.100" });

    const result = await seedOnboardingState(installStateFilePath, configDir);

    expect(result.seeded).toBe(false);
    // Left exactly as it was — never overwritten with the Default install's own version.
    expect(await readProfileState()).toEqual({ hasCompletedOnboarding: true, lastOnboardingVersion: "2.1.100" });
  });
});
