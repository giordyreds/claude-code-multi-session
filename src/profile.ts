import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve as resolvePath } from "node:path";

const PROFILES_DIR_NAME = ".ccacct";

/**
 * Where Profile directories live — see ADR-0006. Overridable via `CCACCT_HOME` so tests never
 * touch a real `$HOME`; defaults to `~/.ccacct`, the state directory ticket #3 also commits to.
 */
export function resolveProfilesRoot(env: NodeJS.ProcessEnv): string {
  const override = env.CCACCT_HOME;
  if (override) return resolvePath(override);
  return join(homedir(), PROFILES_DIR_NAME);
}

/**
 * Resolves an Alias to its Profile's config directory. Per ADR-0006, this is the inverse of
 * ADR-0005's "Alias is the config directory's basename" — there is still no registry to look it
 * up in.
 */
export function resolveProfileDir(alias: string, env: NodeJS.ProcessEnv): string {
  return join(resolveProfilesRoot(env), alias);
}

/**
 * Whether a Profile's directory actually exists on disk — the sole test ADR-0006 uses to decide
 * whether an Alias is "known". A file at that path (not a directory) counts as absent.
 */
export async function profileExists(configDir: string): Promise<boolean> {
  try {
    const info = await stat(configDir);
    return info.isDirectory();
  } catch {
    return false;
  }
}
