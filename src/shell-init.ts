import { readFile } from "node:fs/promises";

/**
 * Stamped into the binary at compile time by `bun build --define` (see
 * `scripts/build-binaries.sh`, ADR-0011) — a standalone compiled binary has no `shell/ccp.sh`
 * beside it at runtime, so this is how a downloaded release still gets the exact file contents.
 * `tsc` has no equivalent substitution, so a plain `npm run build` leaves this identifier
 * undeclared and {@link shellInitScript} falls back to reading the file directly.
 */
declare const EMBEDDED_SHELL_INIT_SCRIPT: string | undefined;

/**
 * `shell/ccp.sh`'s source text. A compiled release binary returns the copy embedded at build time
 * (see {@link EMBEDDED_SHELL_INIT_SCRIPT}); anything else — a local `tsc` build, `vitest` — reads
 * the file fresh on every call rather than duplicating it into the program, so `ccp shell-init`
 * (ADR-0004's Amendment 1, issue #32) and the file it prints can never drift apart there either.
 * `shell/ccp.sh` stays the single source of truth either way.
 *
 * @param scriptUrl Test seam: the file to read on the fallback path. The default resolves the
 * same in both layouts this file ever runs from — `src/shell-init.ts` during tests and
 * `dist/shell-init.js` once built, each one directory below the shipped `shell/` directory (see
 * `package.json`'s `files` list, and {@link packageVersion} in `version.ts` for the identical
 * pattern applied to `package.json`).
 */
export async function shellInitScript(scriptUrl = new URL("../shell/ccp.sh", import.meta.url)): Promise<string> {
  if (typeof EMBEDDED_SHELL_INIT_SCRIPT === "string") return EMBEDDED_SHELL_INIT_SCRIPT;

  try {
    return await readFile(scriptUrl, "utf8");
  } catch (err) {
    throw new Error(`Cannot read ccp's own shell function (${scriptUrl.pathname}): ${err instanceof Error ? err.message : String(err)}`);
  }
}
