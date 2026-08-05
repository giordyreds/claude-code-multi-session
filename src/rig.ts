import { lstat, symlink } from "node:fs/promises";
import { join } from "node:path";
import { isErrnoException } from "./fs-utils.js";

/**
 * The Rig items shared from the Default install into every new Profile — see CONTEXT.md's
 * **Rig** and ADR-0007. Each is a path segment directly under a Claude Code configuration
 * directory. The spike (docs/spikes/0001) found `agents` and `commands` absent from a real
 * Default install, so an item's absence here is ordinary, not exceptional — see {@link shareRig}.
 */
export const RIG_ITEMS = ["CLAUDE.md", "skills", "plugins", "hooks", "agents", "commands"] as const;

/**
 * Shares the Rig into `configDir` by symlinking each {@link RIG_ITEMS} entry that exists under
 * `installDir` — see ADR-0007. An item absent from the Default install (verified by Spike 0001
 * to be ordinary: `agents` and `commands` didn't exist there) is skipped without error, never
 * fabricated as an empty directory. Only these named items are ever linked, so identity and
 * history — the state file, `projects/`, `shell-snapshots/`, `sessions/`, and anything else
 * living alongside them in a config directory — stay real, isolated files this function never
 * touches.
 */
export async function shareRig(installDir: string, configDir: string): Promise<void> {
  for (const item of RIG_ITEMS) {
    const source = join(installDir, item);

    try {
      await lstat(source);
    } catch (err) {
      if (isErrnoException(err) && err.code === "ENOENT") continue;
      throw err;
    }

    await symlink(source, join(configDir, item));
  }
}
