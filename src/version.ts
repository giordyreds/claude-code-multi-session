import { readFile } from "node:fs/promises";

/**
 * Stamped into the binary at compile time by `bun build --define` (see
 * `scripts/build-binaries.sh`, ADR-0011) — a standalone compiled binary has no `package.json`
 * beside it at runtime, so this is how a downloaded release knows its own version. `tsc` has no
 * equivalent substitution, so a plain `npm run build` leaves this identifier undeclared and
 * {@link packageVersion} falls back to reading the manifest directly, which is also what makes
 * the fallback exercisable in tests.
 */
declare const BUILD_VERSION: string | undefined;

/**
 * `ccp`'s own version. A compiled release binary reports the version stamped in at build time
 * (see {@link BUILD_VERSION}); anything else — a local `tsc` build, `vitest` — reads it from the
 * `package.json` that shipped beside the running code, so the two can never disagree there either.
 *
 * Per ADR-0010 this number describes `ccp`'s own surface — its commands, its state layout, its
 * emitted shell line — and says nothing about which Claude Code it works against; a Contract is
 * verified by a Check, never inferred from a version number.
 *
 * @param manifestUrl Test seam: the manifest to read on the fallback path. The default resolves
 * the same in both layouts this file ever runs from — `src/version.ts` during tests and
 * `dist/version.js` once built, each one directory below its own `package.json`.
 */
export async function packageVersion(manifestUrl = new URL("../package.json", import.meta.url)): Promise<string> {
  if (typeof BUILD_VERSION === "string") return BUILD_VERSION;

  let manifest: unknown;
  try {
    manifest = JSON.parse(await readFile(manifestUrl, "utf8"));
  } catch (err) {
    throw new Error(`Cannot read ccp's own package.json (${manifestUrl.pathname}): ${err instanceof Error ? err.message : String(err)}`);
  }

  const version = (manifest as { version?: unknown }).version;
  if (typeof version !== "string" || version.length === 0) {
    throw new Error(`ccp's own package.json (${manifestUrl.pathname}) declares no version`);
  }
  return version;
}
