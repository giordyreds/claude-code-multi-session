import { readFile } from "node:fs/promises";

/**
 * `ccp`'s own version — the one the package declares, read from the `package.json` that shipped
 * beside the running code rather than baked into it at build time, so the two can never disagree.
 *
 * Per ADR-0010 this number describes `ccp`'s own surface — its commands, its state layout, its
 * emitted shell line — and says nothing about which Claude Code it works against; a Contract is
 * verified by a Check, never inferred from a version number.
 *
 * @param manifestUrl Test seam: the manifest to read. The default resolves the same in both
 * layouts this file ever runs from — `src/version.ts` during tests and `dist/version.js` once
 * built and installed, each one directory below its own `package.json`. That file always ships
 * (npm includes it whatever the `files` list says), so the installed case cannot lose it.
 */
export async function packageVersion(manifestUrl = new URL("../package.json", import.meta.url)): Promise<string> {
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
