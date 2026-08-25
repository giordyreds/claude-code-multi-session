import { lstat, mkdir, readlink, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { isErrnoException } from "./fs-utils.js";

/**
 * The Rig items shared from the Default install into every new Profile — see CONTEXT.md's
 * **Rig** and ADR-0007. Each is a path segment directly under a Claude Code configuration
 * directory. The spike (docs/spikes/0001) found `agents` and `commands` absent from a real
 * Default install, so an item's absence here is ordinary, not exceptional — see {@link repairRig}.
 */
export const RIG_ITEMS = ["CLAUDE.md", "skills", "plugins", "hooks", "agents", "commands"] as const;

/** Which {@link RIG_ITEMS} {@link repairRig} actually touched. */
export interface RigRepairResult {
  /** Items freshly linked or relinked because they were missing or pointed somewhere other than
   * the current Default install. Empty when every item already matched — the case that makes
   * running `ccp sync` twice in a row report no changes the second time. */
  repaired: string[];
}

/**
 * Brings `configDir`'s Rig symlinks back in line with `installDir` — `ccp sync`'s repair half of
 * ticket #12, and also what `addProfile` calls directly to share the Rig into a fresh Profile's
 * config directory for the first time (ADR-0007). It's idempotent and self-healing either way: an
 * item already symlinked to the right place is left untouched (reported neither repaired nor an
 * error), a missing item is linked fresh, and anything else in its place — a stale symlink to a
 * since-removed install, or a plain file/directory — is replaced. An item absent from the Default
 * install is skipped, no error (Spike 0001's `agents`/`commands` finding), regardless of whatever
 * configDir currently holds for it: repair never fabricates an item the install itself doesn't
 * have.
 *
 * Also recreates `configDir` itself if it's gone missing entirely, matching `addProfile`'s own
 * `mkdir` — a Profile whose directory was deleted out from under it is exactly the "missing
 * sharing" this repairs, not a reason to fail.
 */
export async function repairRig(installDir: string, configDir: string): Promise<RigRepairResult> {
  await mkdir(configDir, { recursive: true });

  const repaired: string[] = [];
  for (const item of RIG_ITEMS) {
    const source = join(installDir, item);
    if (!(await exists(source))) continue;

    const target = join(configDir, item);
    const currentLink = await readLinkOrUndefined(target);
    if (currentLink === source) continue;

    if (currentLink !== undefined || (await exists(target))) {
      await rm(target, { recursive: true, force: true });
    }
    await symlink(source, target);
    repaired.push(item);
  }

  return { repaired };
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (err) {
    if (isErrnoException(err) && err.code === "ENOENT") return false;
    throw err;
  }
}

/** Reads `path`'s symlink target, or `undefined` if it's missing or isn't a symlink at all
 * (`readlink`'s `EINVAL` on a real file/directory) — both read the same to {@link repairRig}:
 * nothing usable is there yet. */
async function readLinkOrUndefined(path: string): Promise<string | undefined> {
  try {
    return await readlink(path);
  } catch (err) {
    if (isErrnoException(err) && (err.code === "ENOENT" || err.code === "EINVAL")) return undefined;
    throw err;
  }
}
