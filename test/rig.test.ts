import { lstat, mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { repairRig, RIG_ITEMS, shareRig } from "../src/rig.js";

describe("shareRig", () => {
  let installDir: string;
  let configDir: string;

  beforeEach(async () => {
    installDir = await mkdtemp(join(tmpdir(), "ccp-rig-install-"));
    configDir = await mkdtemp(join(tmpdir(), "ccp-rig-profile-"));
  });

  afterEach(async () => {
    await rm(installDir, { recursive: true, force: true });
    await rm(configDir, { recursive: true, force: true });
  });

  it("symlinks each Rig item present in the Default install", async () => {
    await writeFile(join(installDir, "CLAUDE.md"), "# Instructions", "utf8");
    await mkdir(join(installDir, "skills"));
    await writeFile(join(installDir, "skills", "example.md"), "skill", "utf8");

    await shareRig(installDir, configDir);

    expect(await readlink(join(configDir, "CLAUDE.md"))).toBe(join(installDir, "CLAUDE.md"));
    expect(await readlink(join(configDir, "skills"))).toBe(join(installDir, "skills"));
  });

  it("skips every Rig item absent from the Default install, without error", async () => {
    await writeFile(join(installDir, "CLAUDE.md"), "# Instructions", "utf8");

    await expect(shareRig(installDir, configDir)).resolves.toBeUndefined();

    for (const item of RIG_ITEMS) {
      if (item === "CLAUDE.md") continue;
      await expect(lstat(join(configDir, item))).rejects.toThrow();
    }
  });

  it("succeeds without linking anything when the Default install has none of the Rig items", async () => {
    await expect(shareRig(installDir, configDir)).resolves.toBeUndefined();

    for (const item of RIG_ITEMS) {
      await expect(lstat(join(configDir, item))).rejects.toThrow();
    }
  });

  it("shares changes made in the Default install live, since it's a symlink rather than a copy", async () => {
    await mkdir(join(installDir, "skills"));
    await writeFile(join(installDir, "skills", "example.md"), "v1", "utf8");
    await shareRig(installDir, configDir);

    await writeFile(join(installDir, "skills", "example.md"), "v2", "utf8");

    const seenThroughProfile = await readFile(join(configDir, "skills", "example.md"), "utf8");
    expect(seenThroughProfile).toBe("v2");
  });

  it("leaves the Profile's own identity and history files untouched", async () => {
    await writeFile(join(installDir, "CLAUDE.md"), "# Instructions", "utf8");
    await writeFile(join(configDir, ".credentials.json"), "{}", "utf8");
    await mkdir(join(configDir, "projects"));

    await shareRig(installDir, configDir);

    expect((await lstat(join(configDir, ".credentials.json"))).isSymbolicLink()).toBe(false);
    expect((await lstat(join(configDir, "projects"))).isSymbolicLink()).toBe(false);
  });
});

describe("repairRig", () => {
  let installDir: string;
  let configDir: string;

  beforeEach(async () => {
    installDir = await mkdtemp(join(tmpdir(), "ccp-rig-install-"));
    configDir = await mkdtemp(join(tmpdir(), "ccp-rig-profile-"));
  });

  afterEach(async () => {
    await rm(installDir, { recursive: true, force: true });
    await rm(configDir, { recursive: true, force: true });
  });

  it("links a missing item and reports it repaired", async () => {
    await writeFile(join(installDir, "CLAUDE.md"), "# Instructions", "utf8");

    const result = await repairRig(installDir, configDir);

    expect(result.repaired).toEqual(["CLAUDE.md"]);
    expect(await readlink(join(configDir, "CLAUDE.md"))).toBe(join(installDir, "CLAUDE.md"));
  });

  it("reports nothing repaired, and touches nothing, when every item already links correctly", async () => {
    await writeFile(join(installDir, "CLAUDE.md"), "# Instructions", "utf8");
    await repairRig(installDir, configDir);

    const result = await repairRig(installDir, configDir);

    expect(result.repaired).toEqual([]);
    expect(await readlink(join(configDir, "CLAUDE.md"))).toBe(join(installDir, "CLAUDE.md"));
  });

  it("relinks an item pointing at a stale or wrong target", async () => {
    await writeFile(join(installDir, "CLAUDE.md"), "# Instructions", "utf8");
    const staleSource = join(installDir, "stale-target");
    await writeFile(staleSource, "old", "utf8");
    await symlink(staleSource, join(configDir, "CLAUDE.md"));

    const result = await repairRig(installDir, configDir);

    expect(result.repaired).toEqual(["CLAUDE.md"]);
    expect(await readlink(join(configDir, "CLAUDE.md"))).toBe(join(installDir, "CLAUDE.md"));
  });

  it("replaces a plain file or directory standing in for a Rig item", async () => {
    await mkdir(join(installDir, "skills"));
    await mkdir(join(configDir, "skills"));
    await writeFile(join(configDir, "skills", "not-a-symlink.md"), "oops", "utf8");

    const result = await repairRig(installDir, configDir);

    expect(result.repaired).toEqual(["skills"]);
    expect(await readlink(join(configDir, "skills"))).toBe(join(installDir, "skills"));
  });

  it("skips an item absent from the Default install even if configDir has something there", async () => {
    // agents/commands are ordinarily absent (Spike 0001) — repair must never fabricate them.
    const result = await repairRig(installDir, configDir);

    expect(result.repaired).toEqual([]);
    for (const item of RIG_ITEMS) {
      await expect(lstat(join(configDir, item))).rejects.toThrow();
    }
  });

  it("recreates configDir itself if it was deleted out from under the Profile", async () => {
    await writeFile(join(installDir, "CLAUDE.md"), "# Instructions", "utf8");
    await rm(configDir, { recursive: true, force: true });

    const result = await repairRig(installDir, configDir);

    expect(result.repaired).toEqual(["CLAUDE.md"]);
    expect(await readlink(join(configDir, "CLAUDE.md"))).toBe(join(installDir, "CLAUDE.md"));
  });

  it("leaves the Profile's own identity and history files untouched", async () => {
    await writeFile(join(installDir, "CLAUDE.md"), "# Instructions", "utf8");
    await writeFile(join(configDir, ".credentials.json"), "{}", "utf8");
    await mkdir(join(configDir, "projects"));

    await repairRig(installDir, configDir);

    expect((await lstat(join(configDir, ".credentials.json"))).isSymbolicLink()).toBe(false);
    expect((await lstat(join(configDir, "projects"))).isSymbolicLink()).toBe(false);
  });
});
