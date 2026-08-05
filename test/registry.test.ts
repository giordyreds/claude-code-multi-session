import { mkdir, readlink, stat, writeFile } from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  addProfile,
  DEFAULT_INSTALL_ALIAS,
  loadRegistry,
  recordDrift,
  recordExpectedIdentity,
  saveRegistry,
} from "../src/registry.js";

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
        work: { configDir: join(stateDir, "profiles", "work"), expectedIdentity: null, drifted: false },
        personal: {
          configDir: join(stateDir, "profiles", "personal"),
          expectedIdentity: { email: "dev@example.com", orgName: "Acme Corp" },
          drifted: true,
        },
      },
    };

    await saveRegistry(stateDir, registry);

    await expect(loadRegistry(stateDir)).resolves.toEqual(registry);
  });

  it("defaults 'drifted' to false when a registry file predates ticket #8's field", async () => {
    await mkdir(stateDir, { recursive: true });
    await writeFile(
      join(stateDir, "registry.json"),
      JSON.stringify({ profiles: { work: { configDir: "/x", expectedIdentity: null } } }),
      "utf8",
    );

    const registry = await loadRegistry(stateDir);
    expect(registry.profiles.work?.drifted).toBe(false);
  });

  it("throws an actionable error when a profile entry has a non-boolean 'drifted'", async () => {
    await mkdir(stateDir, { recursive: true });
    await writeFile(
      join(stateDir, "registry.json"),
      JSON.stringify({ profiles: { work: { configDir: "/x", expectedIdentity: null, drifted: "yes" } } }),
      "utf8",
    );

    await expect(loadRegistry(stateDir)).rejects.toThrow(/work/);
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
  let installDir: string;

  beforeEach(async () => {
    stateDir = await mkdtemp(join(tmpdir(), "ccp-registry-test-"));
    installDir = await mkdtemp(join(tmpdir(), "ccp-registry-install-"));
  });

  afterEach(async () => {
    await rm(stateDir, { recursive: true, force: true });
    await rm(installDir, { recursive: true, force: true });
  });

  it("creates an isolated config directory under the state directory and registers the Alias", async () => {
    const result = await addProfile(stateDir, "work", installDir);

    expect(result.alias).toBe("work");
    expect(result.configDir.startsWith(stateDir)).toBe(true);

    const dirStat = await stat(result.configDir);
    expect(dirStat.isDirectory()).toBe(true);

    const registry = await loadRegistry(stateDir);
    expect(registry.profiles.work).toEqual({ configDir: result.configDir, expectedIdentity: null, drifted: false });
  });

  it("gives two Profiles distinct config directories", async () => {
    const work = await addProfile(stateDir, "work", installDir);
    const personal = await addProfile(stateDir, "personal", installDir);

    expect(work.configDir).not.toBe(personal.configDir);
  });

  it("rejects a duplicate Alias with an actionable message and changes nothing", async () => {
    const first = await addProfile(stateDir, "work", installDir);
    const registryBefore = await loadRegistry(stateDir);

    await expect(addProfile(stateDir, "work", installDir)).rejects.toThrow(/work/);

    const registryAfter = await loadRegistry(stateDir);
    expect(registryAfter).toEqual(registryBefore);
    expect(registryAfter.profiles.work?.configDir).toBe(first.configDir);
    expect(Object.keys(registryAfter.profiles)).toEqual(["work"]);
  });

  it("rejects an empty Alias", async () => {
    await expect(addProfile(stateDir, "", installDir)).rejects.toThrow(/alias/i);
  });

  it("rejects an Alias containing a path separator, rather than escaping the state directory", async () => {
    await expect(addProfile(stateDir, "../../etc", installDir)).rejects.toThrow(/alias/i);
    await expect(addProfile(stateDir, "sub/dir", installDir)).rejects.toThrow(/alias/i);

    await expect(loadRegistry(stateDir)).resolves.toEqual({ profiles: {} });
  });

  it("rejects '.' and '..' as an Alias even without a path separator", async () => {
    await expect(addProfile(stateDir, ".", installDir)).rejects.toThrow(/alias/i);
    await expect(addProfile(stateDir, "..", installDir)).rejects.toThrow(/alias/i);
  });

  it("rejects '(default)' as an Alias since it's reserved for the Default install", async () => {
    await expect(addProfile(stateDir, DEFAULT_INSTALL_ALIAS, installDir)).rejects.toThrow(/reserved/i);
  });

  it("doesn't mistake an Object.prototype property name for an existing duplicate Alias", async () => {
    const result = await addProfile(stateDir, "constructor", installDir);

    expect(result.alias).toBe("constructor");
    const registry = await loadRegistry(stateDir);
    expect(Object.keys(registry.profiles)).toEqual(["constructor"]);
  });

  it("shares the Rig from the Default install into the new Profile's config directory", async () => {
    await writeFile(join(installDir, "CLAUDE.md"), "# Instructions", "utf8");
    await mkdir(join(installDir, "skills"));

    const result = await addProfile(stateDir, "work", installDir);

    expect(await readlink(join(result.configDir, "CLAUDE.md"))).toBe(join(installDir, "CLAUDE.md"));
    expect(await readlink(join(result.configDir, "skills"))).toBe(join(installDir, "skills"));
  });

  it("skips Rig items absent from the Default install rather than erroring", async () => {
    // This installDir has none of RIG_ITEMS — the Default install spike (0001) found agents/
    // and commands/ absent in a real one, so a Profile must still be created successfully.
    const result = await addProfile(stateDir, "work", installDir);

    const dirStat = await stat(result.configDir);
    expect(dirStat.isDirectory()).toBe(true);
  });
});

describe("recordExpectedIdentity", () => {
  let stateDir: string;
  let installDir: string;

  beforeEach(async () => {
    stateDir = await mkdtemp(join(tmpdir(), "ccp-registry-test-"));
    installDir = await mkdtemp(join(tmpdir(), "ccp-registry-install-"));
  });

  afterEach(async () => {
    await rm(stateDir, { recursive: true, force: true });
    await rm(installDir, { recursive: true, force: true });
  });

  it("records an alias's expected identity without disturbing its configDir", async () => {
    const { configDir } = await addProfile(stateDir, "work", installDir);

    await recordExpectedIdentity(stateDir, "work", { email: "dev@example.com", orgName: "Acme Corp" });

    const registry = await loadRegistry(stateDir);
    expect(registry.profiles.work).toEqual({
      configDir,
      expectedIdentity: { email: "dev@example.com", orgName: "Acme Corp" },
      drifted: false,
    });
  });

  it("clears a previously recorded Drift, since a fresh Expected identity is the new baseline", async () => {
    await addProfile(stateDir, "work");
    await recordDrift(stateDir, "work", true);

    await recordExpectedIdentity(stateDir, "work", { email: "dev@example.com", orgName: "Acme Corp" });

    const registry = await loadRegistry(stateDir);
    expect(registry.profiles.work?.drifted).toBe(false);
  });

  it("leaves every other alias's recorded identity intact when one alias is (re-)recorded", async () => {
    // Exercises the real registry file end-to-end (mkdtemp + real fs, no fake), because this is
    // the isolation guarantee `ccp login`'s acceptance criteria call out by name: logging in one
    // Profile must never disturb another Profile's already-recorded identity.
    await addProfile(stateDir, "work", installDir);
    await addProfile(stateDir, "personal", installDir);

    await recordExpectedIdentity(stateDir, "work", { email: "work@example.com", orgName: "Work Org" });
    await recordExpectedIdentity(stateDir, "personal", { email: "me@example.com", orgName: "Personal Org" });
    await recordExpectedIdentity(stateDir, "work", { email: "work2@example.com", orgName: "Work Org 2" });

    const registry = await loadRegistry(stateDir);
    expect(registry.profiles.personal?.expectedIdentity).toEqual({
      email: "me@example.com",
      orgName: "Personal Org",
    });
    expect(registry.profiles.work?.expectedIdentity).toEqual({
      email: "work2@example.com",
      orgName: "Work Org 2",
    });
  });

  it("throws an actionable error rather than fabricating an entry for an alias that was never added", async () => {
    await expect(
      recordExpectedIdentity(stateDir, "ghost", { email: "dev@example.com", orgName: "Acme Corp" }),
    ).rejects.toThrow(/ghost/);

    await expect(loadRegistry(stateDir)).resolves.toEqual({ profiles: {} });
  });
});

describe("recordDrift", () => {
  let stateDir: string;

  beforeEach(async () => {
    stateDir = await mkdtemp(join(tmpdir(), "ccp-registry-test-"));
  });

  afterEach(async () => {
    await rm(stateDir, { recursive: true, force: true });
  });

  it("records Drift without disturbing configDir or expectedIdentity", async () => {
    const { configDir } = await addProfile(stateDir, "work");
    await recordExpectedIdentity(stateDir, "work", { email: "dev@example.com", orgName: "Acme Corp" });

    await recordDrift(stateDir, "work", true);

    const registry = await loadRegistry(stateDir);
    expect(registry.profiles.work).toEqual({
      configDir,
      expectedIdentity: { email: "dev@example.com", orgName: "Acme Corp" },
      drifted: true,
    });
  });

  it("can clear a previously recorded Drift", async () => {
    await addProfile(stateDir, "work");
    await recordDrift(stateDir, "work", true);

    await recordDrift(stateDir, "work", false);

    const registry = await loadRegistry(stateDir);
    expect(registry.profiles.work?.drifted).toBe(false);
  });

  it("leaves every other alias's Drift state intact", async () => {
    await addProfile(stateDir, "work");
    await addProfile(stateDir, "personal");

    await recordDrift(stateDir, "work", true);

    const registry = await loadRegistry(stateDir);
    expect(registry.profiles.personal?.drifted).toBe(false);
  });

  it("throws an actionable error rather than fabricating an entry for an alias that was never added", async () => {
    await expect(recordDrift(stateDir, "ghost", true)).rejects.toThrow(/ghost/);

    await expect(loadRegistry(stateDir)).resolves.toEqual({ profiles: {} });
  });
});
