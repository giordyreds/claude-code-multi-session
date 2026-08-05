/** Narrows a caught value to Node's ErrnoException shape, so callers can branch on `.code`
 * (e.g. `ENOENT`) without an unsafe cast. Shared by every module that distinguishes "the path
 * doesn't exist" from a genuine failure. */
export function isErrnoException(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && "code" in err;
}
