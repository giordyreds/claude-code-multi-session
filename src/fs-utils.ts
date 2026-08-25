/** Narrows a caught value to Node's ErrnoException shape, so callers can branch on `.code`
 * (e.g. `ENOENT`) without an unsafe cast. Shared by every module that distinguishes "the path
 * doesn't exist" from a genuine failure. */
export function isErrnoException(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && "code" in err;
}

/** Narrows a parsed JSON value to a plain object — not `null`, not an array. Shared by every
 * module that reads a JSON file and needs to reject a top-level scalar or array before indexing
 * into it. */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Renders a caught value as a human-readable message — an `Error`'s `.message`, or the value's
 * string form for anything else a `catch` block might see. Shared by every module that reports a
 * caught error back to the user. */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Prints an error's message to `stderr` and resolves the standard failure exit code — the one
 * shape every command's fallible step reports through. No domain owner of its own (every one of
 * the CLI's 13 commands calls it), which is why it lives here next to {@link errorMessage} rather
 * than in any single `commands/*.ts` module. */
export function reportError(stderr: (line: string) => void, err: unknown): number {
  stderr(errorMessage(err));
  return 1;
}
