import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { configDirFor, expectedIdentityFor, readRegistry, recordExpectedIdentity } from "../src/registry.js";

describe("registry", () => {
  let stateDir: string;

  beforeEach(async () => {
    stateDir = await mkdtemp(join(tmpdir(), "ccp-registry-test-"));
  });

  afterEach(async () => {
    await rm(stateDir, { recursive: true, force: true });
  });

  it("reads an empty registry when no file exists yet", async () => {
    await expect(readRegistry(stateDir)).resolves.toEqual({ profiles: {} });
  });

  it("returns null for an alias with no recorded expected identity", async () => {
    await expect(expectedIdentityFor(stateDir, "work")).resolves.toBeNull();
  });

  it("records and reads back an alias's expected identity", async () => {
    await recordExpectedIdentity(stateDir, "work", { email: "dev@example.com", orgName: "Acme Corp" });

    await expect(expectedIdentityFor(stateDir, "work")).resolves.toEqual({
      email: "dev@example.com",
      orgName: "Acme Corp",
    });
  });

  it("creates the state directory if it doesn't exist yet", async () => {
    const nested = join(stateDir, "nested", "dir");

    await recordExpectedIdentity(nested, "work", { email: "dev@example.com", orgName: "Acme Corp" });

    await expect(readFile(join(nested, "registry.json"), "utf8")).resolves.toContain("dev@example.com");
  });

  it("leaves every other alias's recorded identity intact when one alias is (re-)recorded", async () => {
    // Exercises the real registry file end-to-end (mkdtemp + real fs, no fake), because this is
    // the isolation guarantee `ccp login`'s acceptance criteria call out by name: logging in one
    // Profile must never disturb another Profile's already-recorded identity.
    await recordExpectedIdentity(stateDir, "work", { email: "work@example.com", orgName: "Work Org" });
    await recordExpectedIdentity(stateDir, "personal", { email: "me@example.com", orgName: "Personal Org" });

    await recordExpectedIdentity(stateDir, "work", { email: "work2@example.com", orgName: "Work Org 2" });

    await expect(expectedIdentityFor(stateDir, "personal")).resolves.toEqual({
      email: "me@example.com",
      orgName: "Personal Org",
    });
    await expect(expectedIdentityFor(stateDir, "work")).resolves.toEqual({
      email: "work2@example.com",
      orgName: "Work Org 2",
    });
  });

  it("throws an actionable error when the registry file is malformed JSON", async () => {
    await writeFile(join(stateDir, "registry.json"), "not json", "utf8");

    await expect(readRegistry(stateDir)).rejects.toThrow(/not valid JSON/i);
  });

  it("throws an actionable error when the registry file is well-formed JSON but missing 'profiles'", async () => {
    await writeFile(join(stateDir, "registry.json"), JSON.stringify({ unexpected: true }), "utf8");

    await expect(readRegistry(stateDir)).rejects.toThrow(/malformed/i);
  });
});

describe("configDirFor", () => {
  it("joins the state directory and the alias", () => {
    expect(configDirFor("/state", "work")).toBe(join("/state", "work"));
  });

  it("rejects an empty alias", () => {
    expect(() => configDirFor("/state", "")).toThrow(/not a valid Profile alias/i);
  });

  it("rejects an alias containing a path separator, which would escape the state directory", () => {
    expect(() => configDirFor("/state", "../etc")).toThrow(/not a valid Profile alias/i);
    expect(() => configDirFor("/state", "work/../../etc")).toThrow(/not a valid Profile alias/i);
    expect(() => configDirFor("/state", "sub/dir")).toThrow(/not a valid Profile alias/i);
  });

  it("rejects a bare '.' or '..' alias", () => {
    expect(() => configDirFor("/state", ".")).toThrow(/not a valid Profile alias/i);
    expect(() => configDirFor("/state", "..")).toThrow(/not a valid Profile alias/i);
  });
});
