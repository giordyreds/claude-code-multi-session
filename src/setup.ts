import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { readFileOrEmpty, SHELL_WIRING_LINE } from "./doctor.js";

/**
 * `ccp setup`'s and `ccp teardown`'s shared building block (issue #35): adding and removing
 * {@link SHELL_WIRING_LINE} from a shell startup file. Kept separate from `doctor.ts`'s Shell
 * wiring Check — which only ever reads the file — because these two functions are this project's
 * only writes to a file `ccp` doesn't own itself. Both detect presence the exact same way that
 * Check does (`content.includes(SHELL_WIRING_LINE)` against the one exported constant), so what
 * Setup considers "already wired" and what `ccp doctor` reports as "present" can never disagree.
 */

export interface WriteShellWiringResult {
  /** Whether this call actually appended the line — `false` when it was already present, so a
   * second `ccp setup` run reports "nothing to add" instead of adding a duplicate (issue #35's
   * "running Setup twice changes nothing the second time"). */
  added: boolean;
}

/**
 * Appends {@link SHELL_WIRING_LINE} to `zshrcPath`, unless it's already present. Idempotent by
 * construction: a second call against a file this already wrote to finds the line via the same
 * `includes` check and does nothing.
 *
 * Creates `zshrcPath`'s parent directory first (`mkdir` with `recursive: true`) — a no-op on a
 * real machine, where `$ZDOTDIR` or `$HOME` always exists, and only actually matters for a
 * from-scratch test seam that hasn't created one yet.
 *
 * Preserves everything already in the file: appends after the existing content (adding a
 * newline first only if the file is non-empty and doesn't already end in one), never overwriting
 * or reordering a byte of it.
 */
export async function writeShellWiringLine(zshrcPath: string): Promise<WriteShellWiringResult> {
  const existing = await readFileOrEmpty(zshrcPath);
  if (existing.includes(SHELL_WIRING_LINE)) return { added: false };

  const needsLeadingNewline = existing.length > 0 && !existing.endsWith("\n");
  await mkdir(dirname(zshrcPath), { recursive: true });
  await writeFile(zshrcPath, `${existing}${needsLeadingNewline ? "\n" : ""}${SHELL_WIRING_LINE}\n`, "utf8");
  return { added: true };
}

export interface RemoveShellWiringResult {
  /** Whether this call actually removed a line — `false` when the file had none to remove
   * (issue #35's "safe to run when no line is present"), including when the file doesn't exist
   * at all. */
  removed: boolean;
}

/**
 * The inverse of {@link writeShellWiringLine} (issue #35's Setup inverse, `ccp teardown`):
 * removes every line exactly matching {@link SHELL_WIRING_LINE} from `zshrcPath`, leaving every
 * other line untouched — including one a user wrote by hand right next to it. Never touches
 * anything else: not Profiles, not the state directory, not the file at all when there's nothing
 * to remove from it.
 *
 * Splits on `"\n"` and filters, rather than a regex replace across the whole text, so a line
 * that merely *contains* the wiring line as a substring of something longer is left alone —
 * only a line that matches it exactly is ever removed.
 */
export async function removeShellWiringLine(zshrcPath: string): Promise<RemoveShellWiringResult> {
  const existing = await readFileOrEmpty(zshrcPath);
  if (!existing.includes(SHELL_WIRING_LINE)) return { removed: false };

  const kept = existing.split("\n").filter((line) => line !== SHELL_WIRING_LINE);
  await writeFile(zshrcPath, kept.join("\n"), "utf8");
  return { removed: true };
}
