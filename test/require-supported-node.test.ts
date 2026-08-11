import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The supported Node range is enforced, not merely advertised: npm treats an `engines` mismatch as
 * a warning by default (verified against npm 11.17), so declaring the range alone would let an
 * unsupported runtime build `ccp` from source and fail later, from inside it. `npm run build`
 * refuses instead (see `scripts/require-supported-node.mjs`, ADR-0011), which is what turns the
 * declaration into a build that did not happen.
 *
 * Extracted from what used to be `packaging.test.ts`: that file also asserted on `npm pack`'s
 * output, which described ADR-0009's now-superseded npm-install model. This gate outlived it —
 * `ccp` is still built from source, just no longer at install time on an end user's machine.
 */
const repoRoot = fileURLToPath(new URL("..", import.meta.url));

describe("supported Node version gate", () => {
  const gate = join(repoRoot, "scripts", "require-supported-node.mjs");

  it("accepts the Node version running this test", () => {
    const result = spawnSync(process.execPath, [gate], { encoding: "utf8" });

    expect(result.status).toBe(0);
  });

  it("refuses an unsupported Node version, naming both it and the range it wanted", () => {
    const result = spawnSync(process.execPath, [gate, "18.20.8"], { encoding: "utf8" });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("18.20.8");
    expect(result.stderr).toMatch(/>=\d+(\.\d+){0,2}/);
  });

  it("accepts the oldest Node the package claims to support", async () => {
    const { engines } = JSON.parse(await readFile(join(repoRoot, "package.json"), "utf8"));
    const floor = engines.node.replace(">=", "");

    const result = spawnSync(process.execPath, [gate, floor], { encoding: "utf8" });

    expect(result.status).toBe(0);
  });
});
