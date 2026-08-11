import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { packageVersion } from "../src/version.js";

/**
 * `ccp --version` exists so a bug report can quote something exact (PRD #28), which makes a
 * failure to produce it worth a clear message rather than a raw `ENOENT`: the two ways a manifest
 * can let us down each name the file they were unhappy with.
 */
describe("packageVersion", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "ccp-version-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("reads the version the package declares", async () => {
    const manifest = join(root, "package.json");
    await writeFile(manifest, JSON.stringify({ version: "1.2.3" }));

    await expect(packageVersion(pathToFileURL(manifest))).resolves.toBe("1.2.3");
  });

  it("names the manifest it could not read", async () => {
    const missing = join(root, "package.json");

    await expect(packageVersion(pathToFileURL(missing))).rejects.toThrow(missing);
  });

  it("names the manifest that declares no version", async () => {
    const manifest = join(root, "package.json");
    await writeFile(manifest, JSON.stringify({ name: "claude-code-multi-session" }));

    await expect(packageVersion(pathToFileURL(manifest))).rejects.toThrow(/declares no version/);
  });
});
