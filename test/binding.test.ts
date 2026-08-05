import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveBinding } from "../src/binding.js";

describe("resolveBinding", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "ccp-binding-test-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("reports unbound when CLAUDE_CONFIG_DIR is not set", () => {
    expect(resolveBinding({})).toEqual({ bound: false });
  });

  it("reports unbound when CLAUDE_CONFIG_DIR is an empty string", () => {
    expect(resolveBinding({ CLAUDE_CONFIG_DIR: "" })).toEqual({ bound: false });
  });

  it("reports the bound Profile, with Alias taken from the directory's basename", async () => {
    const profileDir = join(root, "work");

    expect(resolveBinding({ CLAUDE_CONFIG_DIR: profileDir })).toEqual({
      bound: true,
      alias: "work",
      configDir: profileDir,
    });
  });

  it("strips a trailing slash before deriving the Alias", () => {
    const profileDir = join(root, "work");

    expect(resolveBinding({ CLAUDE_CONFIG_DIR: `${profileDir}/` })).toEqual({
      bound: true,
      alias: "work",
      configDir: profileDir,
    });
  });

  it("resolves a relative CLAUDE_CONFIG_DIR against the current working directory", () => {
    const originalCwd = process.cwd();
    process.chdir(root);
    try {
      // Compared against process.cwd() itself, not the pre-chdir `root` string: on macOS `/tmp`
      // is a symlink to `/private/tmp`, and chdir(2) returns the canonicalized path — so deriving
      // the expectation from `root` directly would fail on a symlink mismatch that has nothing to
      // do with resolveBinding's own correctness.
      expect(resolveBinding({ CLAUDE_CONFIG_DIR: "work" })).toEqual({
        bound: true,
        alias: "work",
        configDir: join(process.cwd(), "work"),
      });
    } finally {
      process.chdir(originalCwd);
    }
  });
});
