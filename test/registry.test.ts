import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addProfile, DEFAULT_INSTALL_ALIAS, loadRegistry, saveRegistry } from "../src/registry.js";

describe("loadRegistry", () => {
  let stateDir: string;

  beforeEach(async () => {
    stateDir = await mkdtemp(join(tmpdir(), "ccp-registry-test-"));
  });

  afterEach(async () => {
    await rm(stateDir, { recursive: true, force: true });
  });

  it("returns an empty registry when the registry file doesn't exist yet", async () => {
    await expect(loadRegistry(stateDir)).resolves.toEqual({ profiles: {} });
  });

  it("round-trips a saved registry", async () => {
    const registry = {
      profiles: {
        work: { configDir: join(stateDir, "profiles", "work"), expectedIdentity: null },
        personal: {
          configDir: join(stateDir, "profiles", "personal"),
          expectedIdentity: { email: "dev@example.com", orgName: "Acme Corp" },
        },
      },
    };

    await saveRegistry(stateDir, registry);

    await expect(loadRegistry(stateDir)).resolves.toEqual(registry);
  });

  it("throws an actionable error rather than resetting when the registry file isn't valid JSON", async () => {
    await mkdir(stateDir, { recursive: true });
    await writeFile(join(stateDir, "registry.json"), "not json", "utf8");

    await expect(loadRegistry(stateDir)).rejects.toThrow(/registry/i);
  });

  it("throws an actionable error rather than resetting when 'profiles' is missing", async () => {
    await mkdir(stateDir, { recursive: true });
    await writeFile(join(stateDir, "registry.json"), JSON.stringify({}), "utf8");

    await expect(loadRegistry(stateDir)).rejects.toThrow(/registry/i);
  });

  it("throws an actionable error rather than resetting when 'profiles' is the wrong shape", async () => {
    await mkdir(stateDir, { recursive: true });
    await writeFile(join(stateDir, "registry.json"), JSON.stringify({ profiles: [] }), "utf8");

    await expect(loadRegistry(stateDir)).rejects.toThrow(/registry/i);
  });

  it("throws an actionable error when a profile entry is missing configDir", async () => {
    await mkdir(stateDir, { recursive: true });
    await writeFile(
      join(stateDir, "registry.json"),
      JSON.stringify({ profiles: { work: { expectedIdentity: null } } }),
      "utf8",
    );

    await expect(loadRegistry(stateDir)).rejects.toThrow(/work/);
  });

  it("throws an actionable error when a profile entry has a malformed expectedIdentity", async () => {
    await mkdir(stateDir, { recursive: true });
    await writeFile(
      join(stateDir, "registry.json"),
      JSON.stringify({ profiles: { work: { configDir: "/x", expectedIdentity: { email: "only-email" } } } }),
      "utf8",
    );

    await expect(loadRegistry(stateDir)).rejects.toThrow(/work/);
  });
});

describe("addProfile", () => {
  let stateDir: string;

  beforeEach(async () => {
    stateDir = await mkdtemp(join(tmpdir(), "ccp-registry-test-"));
  });

  afterEach(async () => {
    await rm(stateDir, { recursive: true, force: true });
  });

  it("creates an isolated config directory under the state directory and registers the Alias", async () => {
    const result = await addProfile(stateDir, "work");

    expect(result.alias).toBe("work");
    expect(result.configDir.startsWith(stateDir)).toBe(true);

    const dirStat = await stat(result.configDir);
    expect(dirStat.isDirectory()).toBe(true);

    const registry = await loadRegistry(stateDir);
    expect(registry.profiles.work).toEqual({ configDir: result.configDir, expectedIdentity: null });
  });

  it("gives two Profiles distinct config directories", async () => {
    const work = await addProfile(stateDir, "work");
    const personal = await addProfile(stateDir, "personal");

    expect(work.configDir).not.toBe(personal.configDir);
  });

  it("rejects a duplicate Alias with an actionable message and changes nothing", async () => {
    const first = await addProfile(stateDir, "work");
    const registryBefore = await loadRegistry(stateDir);

    await expect(addProfile(stateDir, "work")).rejects.toThrow(/work/);

    const registryAfter = await loadRegistry(stateDir);
    expect(registryAfter).toEqual(registryBefore);
    expect(registryAfter.profiles.work?.configDir).toBe(first.configDir);
    expect(Object.keys(registryAfter.profiles)).toEqual(["work"]);
  });

  it("rejects an empty Alias", async () => {
    await expect(addProfile(stateDir, "")).rejects.toThrow(/alias/i);
  });

  it("rejects an Alias containing a path separator, rather than escaping the state directory", async () => {
    await expect(addProfile(stateDir, "../../etc")).rejects.toThrow(/alias/i);
    await expect(addProfile(stateDir, "sub/dir")).rejects.toThrow(/alias/i);

    await expect(loadRegistry(stateDir)).resolves.toEqual({ profiles: {} });
  });

  it("rejects '.' and '..' as an Alias even without a path separator", async () => {
    await expect(addProfile(stateDir, ".")).rejects.toThrow(/alias/i);
    await expect(addProfile(stateDir, "..")).rejects.toThrow(/alias/i);
  });

  it("rejects '(default)' as an Alias since it's reserved for the Default install", async () => {
    await expect(addProfile(stateDir, DEFAULT_INSTALL_ALIAS)).rejects.toThrow(/reserved/i);
  });

  it("doesn't mistake an Object.prototype property name for an existing duplicate Alias", async () => {
    const result = await addProfile(stateDir, "constructor");

    expect(result.alias).toBe("constructor");
    const registry = await loadRegistry(stateDir);
    expect(Object.keys(registry.profiles)).toEqual(["constructor"]);
  });
});
