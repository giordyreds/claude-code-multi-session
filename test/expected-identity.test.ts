import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readExpectedIdentity } from "../src/expected-identity.js";

describe("readExpectedIdentity", () => {
  let configDir: string;

  beforeEach(async () => {
    configDir = await mkdtemp(join(tmpdir(), "ccp-expected-identity-test-"));
  });

  afterEach(async () => {
    await rm(configDir, { recursive: true, force: true });
  });

  it("is undefined when the Profile has never recorded an expected identity", async () => {
    await expect(readExpectedIdentity(configDir)).resolves.toBeUndefined();
  });

  it("reads the recorded email and orgName once ccp login (future #4) has written them", async () => {
    await mkdir(join(configDir, ".ccp"));
    await writeFile(
      join(configDir, ".ccp", "expected-identity.json"),
      JSON.stringify({ email: "dev@example.com", orgName: "Acme Corp" }),
    );

    await expect(readExpectedIdentity(configDir)).resolves.toEqual({
      email: "dev@example.com",
      orgName: "Acme Corp",
    });
  });

  it("is undefined, not a crash, when the file is malformed JSON", async () => {
    await mkdir(join(configDir, ".ccp"));
    await writeFile(join(configDir, ".ccp", "expected-identity.json"), "not json");

    await expect(readExpectedIdentity(configDir)).resolves.toBeUndefined();
  });

  it("is undefined, not a crash, when the file is well-formed JSON but the wrong shape", async () => {
    await mkdir(join(configDir, ".ccp"));
    await writeFile(join(configDir, ".ccp", "expected-identity.json"), JSON.stringify([1, 2, 3]));

    await expect(readExpectedIdentity(configDir)).resolves.toBeUndefined();
  });
});
