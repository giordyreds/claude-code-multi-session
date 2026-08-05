import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { profileExists, resolveProfileDir, resolveProfilesRoot } from "../src/profile.js";

describe("resolveProfilesRoot", () => {
  it("uses CCACCT_HOME when set, so tests never touch a real $HOME", () => {
    expect(resolveProfilesRoot({ CCACCT_HOME: "/tmp/example-home" })).toBe("/tmp/example-home");
  });

  it("falls back to ~/.ccacct when CCACCT_HOME is unset", () => {
    const root = resolveProfilesRoot({});
    expect(root).toMatch(/\.ccacct$/);
  });
});

describe("resolveProfileDir", () => {
  it("joins the profiles root with the Alias", () => {
    expect(resolveProfileDir("work", { CCACCT_HOME: "/tmp/example-home" })).toBe(join("/tmp/example-home", "work"));
  });
});

describe("profileExists", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "ccp-profile-test-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("is false for an Alias with no directory on disk", async () => {
    await expect(profileExists(join(root, "ghost"))).resolves.toBe(false);
  });

  it("is true once the Profile's directory has been created", async () => {
    const dir = join(root, "work");
    await mkdir(dir);

    await expect(profileExists(dir)).resolves.toBe(true);
  });

  it("is false when the path exists but is a file, not a directory", async () => {
    const filePath = join(root, "not-a-dir");
    await writeFile(filePath, "oops");

    await expect(profileExists(filePath)).resolves.toBe(false);
  });
});
