import { join } from "node:path";
import { resolveBinding } from "../binding.js";
import type { CliDeps, Command } from "../cli-deps.js";
import { errorMessage, reportError } from "../fs-utils.js";
import { addProfile, DEFAULT_INSTALL_ALIAS, loadRegistry, removeProfile, type ProfileRecord } from "../registry.js";
import { repairRig } from "../rig.js";
import { renderSettings } from "../settings.js";
import { resolveKnownProfile } from "./shared.js";

const RM_USAGE = "Usage: ccp rm <alias> --yes";

/** The Default install's live settings file — the base every Profile's settings render from
 * (ADR-0002) — and the name the rendered result takes in each Profile's own config directory
 * too, since both are just "the settings file" in their respective directories. */
const BASE_SETTINGS_FILE_NAME = "settings.json";

/** A Profile's optional per-Profile override (ADR-0002's third table row). Lives inside the
 * Profile's own config directory, next to its real identity/history files rather than anywhere
 * shared, and is the file a Profile owner is meant to hand-edit directly — unlike the *rendered*
 * `settings.json` beside it, which {@link renderSettings} refuses to clobber once hand-edited. */
const OVERRIDE_SETTINGS_FILE_NAME = "settings.override.json";

/** Profile lifecycle: `add`, `rm`, `sync` (ADR-0015). */
export const PROFILE_COMMANDS: Record<string, Command> = {
  add: runAdd,
  rm: runRm,
  sync: runSync,
};

/**
 * `ccp add <alias>`: creates a Profile with its own isolated config directory under the tool's
 * state directory and registers its Alias. Alias validity — uniqueness, and the reserved
 * {@link DEFAULT_INSTALL_ALIAS} sentinel — is enforced by {@link addProfile} itself, so a
 * rejection here always means the registry was left exactly as it was.
 */
async function runAdd(args: string[], deps: CliDeps): Promise<number> {
  const alias = args[0];
  if (!alias) {
    deps.stderr("Usage: ccp add <alias>");
    return 1;
  }

  try {
    const result = await addProfile(deps.stateDir, alias, deps.installDir);
    deps.stdout(`Created Profile '${result.alias}' at ${result.configDir}`);
    return 0;
  } catch (err) {
    return reportError(deps.stderr, err);
  }
}

/**
 * `ccp rm <alias>`: permanently removes a Profile — its registry entry, its isolated config
 * directory (history included), and, on a best-effort basis, its background daemon (ADR-0001).
 * Never removes the Default install (checked here by name, ahead of even the confirmation
 * prompt, so no confirmation wording ever has to talk about it) — {@link removeProfile} enforces
 * the same rule again, since it's reachable directly too.
 *
 * Requires an explicit `--yes` (or `-y`), named in the acceptance criteria as the point of the
 * confirmation: irreversibly losing a Profile's isolated history. Withheld, this changes nothing
 * — no daemon touched, no directory removed, no registry write.
 *
 * Daemon cleanup runs *after* {@link removeProfile} succeeds, not before: {@link removeProfile}
 * can still fail (a filesystem error, a race), and it must stay all-or-nothing — the registry
 * entry and config directory either both go or neither does. Running the daemon step last means a
 * failed removal never leaves a Profile alive with its daemon already killed out from under it.
 * The daemon step's own failure only ever warns (ticket's own acceptance criteria: best-effort,
 * never blocking) — by the time it runs, the removal it might fail to clean up after has already
 * succeeded. Binding to the alias being removed is reported the same way `ccp use`'s Drift is: a
 * warning on stderr, never a block, since a shell already bound is Binding's own property
 * (CONTEXT.md) and clears on its own once nothing is left to point at.
 */
async function runRm(args: string[], deps: CliDeps): Promise<number> {
  const alias = args[0];
  if (!alias) {
    deps.stderr(RM_USAGE);
    return 1;
  }

  if (alias === DEFAULT_INSTALL_ALIAS) {
    deps.stderr(`'${DEFAULT_INSTALL_ALIAS}' is the Default install and can never be removed.`);
    return 1;
  }

  const record = await resolveKnownProfile(deps, alias);
  if (!record) return 1;

  const confirmed = args.slice(1).some((arg) => arg === "--yes" || arg === "-y");
  if (!confirmed) {
    deps.stderr(
      `Removing '${alias}' permanently deletes its configuration and isolated history — this cannot be undone. Re-run 'ccp rm ${alias} --yes' to confirm.`,
    );
    return 1;
  }

  const binding = resolveBinding(deps.env);
  if (binding.bound && binding.alias === alias) {
    deps.stderr(
      `Warning: the current shell is bound to '${alias}'. It will keep pointing at a now-deleted configuration until it's rebound with 'ccp use'.`,
    );
  }

  try {
    await removeProfile(deps.stateDir, alias);
  } catch (err) {
    return reportError(deps.stderr, err);
  }

  try {
    await deps.daemonPort.stopDaemon(record.configDir);
  } catch (err) {
    deps.stderr(`Warning: could not clean up the background daemon for '${alias}': ${err instanceof Error ? err.message : String(err)}`);
  }

  deps.stdout(`Removed Profile '${alias}'.`);
  return 0;
}

/**
 * `ccp sync`: brings every registered Profile back in line with the Rig and the base settings
 * (ticket #12) — the maintenance counterpart to `ccp add`, which only ever assembles a Profile
 * once, at creation. Every Profile is attempted regardless of an earlier one's outcome: a broken
 * Profile is reported and skipped, per this ticket's acceptance criteria, rather than aborting
 * the run and leaving every later Profile un-synced too.
 *
 * Settings render from the Default install's live settings file plus this Profile's own
 * {@link OVERRIDE_SETTINGS_FILE_NAME} — a hand-authored file distinct from the *rendered*
 * settings file beside it, which {@link renderSettings} refuses to clobber once hand-edited
 * (ticket #7). That refusal surfaces here as one Profile's line reading `SKIPPED`, never a thrown
 * error that would stop the rest of the run. Both repair steps report whether they actually
 * changed anything, so running `sync` again immediately, with nothing left to fix, reports no
 * changes for every Profile the second time.
 *
 * "What was skipped" (this ticket's own words) means a whole Profile `sync` couldn't act on, not
 * an individual Rig item absent from the Default install: {@link repairRig} already treats that
 * as ordinary, silent-by-design state (Spike 0001's `agents`/`commands` finding, same as it always
 * has for `addProfile`), and naming it in every Profile's line on every run would turn
 * permanently-normal state into noise that drowns out the one line that actually needs attention.
 */
async function runSync(_args: string[], deps: CliDeps): Promise<number> {
  let profiles;
  try {
    profiles = (await loadRegistry(deps.stateDir)).profiles;
  } catch (err) {
    return reportError(deps.stderr, err);
  }

  const aliases = Object.keys(profiles).sort((a, b) => a.localeCompare(b));
  if (aliases.length === 0) {
    deps.stdout("No Profiles to sync.");
    return 0;
  }

  let anySkipped = false;
  const lines: string[] = [];
  for (const alias of aliases) {
    const result = await syncProfile(alias, profiles[alias]!, deps.installDir);
    lines.push(result.line);
    if (result.skipped) anySkipped = true;
  }

  deps.stdout(lines.join("\n"));
  return anySkipped ? 1 : 0;
}

/** One Profile's outcome from a single `ccp sync` pass. */
interface ProfileSyncResult {
  /** The report line `runSync` prints for this Profile — either what changed, `no changes`, or a
   * `SKIPPED` line naming why. */
  line: string;
  /** Whether this Profile's own problem (most commonly {@link renderSettings}'s hand-edit
   * refusal) kept it from syncing — drives `runSync`'s non-zero exit code. */
  skipped: boolean;
}

/**
 * Syncs one Profile: repairs its Rig sharing, then re-renders its settings. Never throws — either
 * step's failure (most commonly {@link renderSettings}'s hand-edit refusal) is caught and turned
 * into that Profile's own `SKIPPED` line, so one Profile's problem can never take the rest of
 * `ccp sync`'s run down with it.
 */
async function syncProfile(alias: string, record: ProfileRecord, installDir: string): Promise<ProfileSyncResult> {
  const changes: string[] = [];

  try {
    const { repaired } = await repairRig(installDir, record.configDir);
    if (repaired.length > 0) changes.push(`Rig repaired (${repaired.join(", ")})`);
  } catch (err) {
    return { line: `${alias}: SKIPPED — ${errorMessage(err)}`, skipped: true };
  }

  try {
    const result = await renderSettings({
      baseSettingsPath: join(installDir, BASE_SETTINGS_FILE_NAME),
      overrideSettingsPath: join(record.configDir, OVERRIDE_SETTINGS_FILE_NAME),
      outputSettingsPath: join(record.configDir, BASE_SETTINGS_FILE_NAME),
    });
    if (result.changed) changes.push("settings re-rendered");
  } catch (err) {
    return { line: `${alias}: SKIPPED — ${errorMessage(err)}`, skipped: true };
  }

  return {
    line: changes.length > 0 ? `${alias}: ${changes.join("; ")}` : `${alias}: no changes`,
    skipped: false,
  };
}
