import { execFileSync, spawnSync } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

/**
 * Guards the one failure mode that no unit test can see: a package that installs but does not
 * run. ADR-0009 makes `npm i -g github:giordyreds/claude-code-multi-session` the only supported
 * way to get `ccp`, and that command's success depends entirely on which files end up inside the
 * package — a question answered by npm, not by this code. So these tests ask npm, by running the
 * real packaging tool as a subprocess and asserting on its machine-readable output, rather than
 * re-implementing its file-selection rules and testing the re-implementation.
 *
 * `npm pack --dry-run` also runs the `prepare` step, so a green run additionally proves the
 * package still builds from source at install time (issue #30) — no build output is committed,
 * and none has to be.
 */
const repoRoot = fileURLToPath(new URL("..", import.meta.url));

/** Every path `npm pack` would place inside the tarball, as npm reports them: relative to the
 * package root, with no `package/` prefix. */
function packedPaths(): string[] {
  const stdout = execFileSync("npm", ["pack", "--dry-run", "--json"], {
    cwd: repoRoot,
    encoding: "utf8",
    // Only stdout is captured: npm writes the human-readable file listing and any lifecycle
    // output to stderr, so stdout carries nothing but the JSON document.
    stdio: ["ignore", "pipe", "ignore"],
  });
  const [pack] = JSON.parse(stdout) as Array<{ files: Array<{ path: string }> }>;
  if (!pack) throw new Error("npm pack --json reported no package");
  return pack.files.map((file) => file.path);
}

describe("package contents", () => {
  let paths: string[];
  let manifest: { bin: Record<string, string>; engines?: { node?: string } };

  beforeAll(async () => {
    paths = packedPaths();
    manifest = JSON.parse(await readFile(join(repoRoot, "package.json"), "utf8"));
  }, 300_000);

  it("ships the built entry point the ccp command points at", () => {
    // Read from `bin` rather than hard-coded, so this asserts what the installed `ccp` symlink
    // will actually resolve to — the file whose absence made the installed command a dangling
    // symlink (issue #30).
    const entryPoint = manifest.bin.ccp;

    expect(entryPoint).toBeTruthy();
    expect(paths).toContain(entryPoint);
  });

  it("ships the shell function file", () => {
    // Setup reads this file at runtime to wire `ccp` into a shell (ADR-0004), so an installation
    // without it can bind nothing.
    expect(paths).toContain("shell/ccp.sh");
  });

  it("declares its files explicitly, shipping no sources or tests", () => {
    // The explicit `files` list is what keeps the package to what it needs to run. Asserting the
    // absence of sources — rather than only the presence of the build output — is what makes this
    // test fail if that list is ever dropped, since without it npm ships the whole tree.
    expect(paths.filter((path) => path.startsWith("src/"))).toEqual([]);
    expect(paths.filter((path) => path.startsWith("test/"))).toEqual([]);
  });

  it("keeps a package-level ignore file, so no git-ignore fallback can strip the build output", () => {
    // Asserted by existence rather than by behaviour, deliberately. npm consults `.gitignore`
    // only when a package declares no ignore file of its own, and the build output directory is
    // git-ignored — so on the npm versions that apply that fallback, deleting this file strips
    // `dist/` from the package and reinstates the broken install of issue #30. Current npm
    // (11.17, verified) no longer applies the fallback, which is exactly why the regression it
    // guards against would pass unnoticed here.
    return expect(access(join(repoRoot, ".npmignore"))).resolves.toBeUndefined();
  });

  it("declares the Node versions it supports, in the form the install-time gate understands", () => {
    expect(manifest.engines?.node).toMatch(/^>=\d+(\.\d+){0,2}$/);
  });
});

/**
 * The supported Node range is enforced, not merely advertised: npm treats an `engines` mismatch as
 * a warning by default (verified against npm 11.17), so declaring the range alone would let an
 * unsupported runtime install cleanly and fail later, from inside `ccp`. The install-time build
 * step refuses instead, which is what turns the declaration into an install that did not happen.
 */
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
