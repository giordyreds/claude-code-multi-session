import { readFile } from "node:fs/promises";
import { isErrnoException } from "./fs-utils.js";

/**
 * The exact guarded line Setup (CONTEXT.md) adds to a shell startup file (`.zshrc` or `.bashrc`,
 * see `defaultShellRcPath`, `src/cli.ts`, issue #40) — README.md's install instructions,
 * ADR-0004's Amendment 1 (issue #32). `ccp doctor`'s Shell wiring Check looks for this precise
 * text and prints it verbatim when it's missing, so what a user is told to add is exactly what
 * Setup would have added — one source of truth for the line, not two. Plain POSIX `sh`, needing
 * no bash/zsh distinction of its own.
 *
 * Lives in this leaf module rather than `setup.ts` or `doctor.ts` (issue #56): `setup.ts` writes
 * and removes this line, `doctor.ts`'s Shell wiring Check only ever reads for it, and neither is
 * the right owner of a constant the other equally depends on — putting it here means neither
 * module imports from the other just to reach it.
 */
export const SHELL_WIRING_LINE = 'if command -v ccp >/dev/null 2>&1; then eval "$(command ccp shell-init)"; fi';

/** Reads `path`, resolving `""` when it doesn't exist rather than throwing — shared by `setup.ts`,
 * which needs the exact same "missing file reads as empty" semantics to decide whether
 * {@link SHELL_WIRING_LINE} is already present before writing or removing it, and by this
 * module's own {@link isPresent}, so Setup and `ccp doctor`'s Shell wiring Check can never
 * disagree about what "present" means. */
export async function readFileOrEmpty(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (err) {
    if (isErrnoException(err) && err.code === "ENOENT") return "";
    throw err;
  }
}

/**
 * Whether {@link SHELL_WIRING_LINE} is already present in `shellRcPath` — the one predicate
 * `doctor.ts`'s Shell wiring Check, `setup.ts`'s write/remove, and `ccp setup`'s `--dry-run`
 * preview (`src/cli.ts`) all need, shared here so "present" can never mean something subtly
 * different at one of those call sites than at another.
 */
export async function isPresent(shellRcPath: string): Promise<boolean> {
  return (await readFileOrEmpty(shellRcPath)).includes(SHELL_WIRING_LINE);
}
