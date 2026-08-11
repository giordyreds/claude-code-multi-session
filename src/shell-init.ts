import { readFile } from "node:fs/promises";

/**
 * `shell/ccp.sh`'s source text — read fresh on every call rather than duplicated into the
 * program, so `ccp shell-init` (ADR-0004's Amendment 1, issue #32) and the file it prints can
 * never drift apart. `shell/ccp.sh` stays the single source of truth; this is the one place that
 * reads it.
 *
 * @param scriptUrl Test seam: the file to read. The default resolves the same in both layouts
 * this file ever runs from — `src/shell-init.ts` during tests and `dist/shell-init.js` once built
 * and installed, each one directory below the shipped `shell/` directory (see `package.json`'s
 * `files` list, and {@link packageVersion} in `version.ts` for the identical pattern applied to
 * `package.json`).
 */
export async function shellInitScript(scriptUrl = new URL("../shell/ccp.sh", import.meta.url)): Promise<string> {
  try {
    return await readFile(scriptUrl, "utf8");
  } catch (err) {
    throw new Error(`Cannot read ccp's own shell function (${scriptUrl.pathname}): ${err instanceof Error ? err.message : String(err)}`);
  }
}
