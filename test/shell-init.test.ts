import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { shellInitScript } from "../src/shell-init.js";

/**
 * `ccp shell-init` (ADR-0004's Amendment 1, issue #32) reads `shell/ccp.sh` fresh on every call
 * rather than duplicating its text into the program, so the file and what gets `eval`'d can never
 * drift apart. Mirrors `version.test.ts`'s treatment of the identical pattern in `packageVersion`.
 */
describe("shellInitScript", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "ccp-shell-init-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("reads the shell function file's exact contents", async () => {
    const script = join(root, "ccp.sh");
    await writeFile(script, "ccp() {\n  command ccp \"$@\"\n}\n");

    await expect(shellInitScript(pathToFileURL(script))).resolves.toBe('ccp() {\n  command ccp "$@"\n}\n');
  });

  it("names the file it could not read", async () => {
    const missing = join(root, "ccp.sh");

    await expect(shellInitScript(pathToFileURL(missing))).rejects.toThrow(missing);
  });
});
