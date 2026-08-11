import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isPlainObject } from "./fs-utils.js";

/** The name Claude Code gives a bound Profile's own state file — confirmed by probe (ADR-0008's
 * amendment) to live directly inside its `CLAUDE_CONFIG_DIR`, i.e. `configDir/.claude.json`. This
 * is *not* where the Default install's own copy lives, which is why {@link seedOnboardingState}
 * takes that source as a full file path rather than deriving it the same way — see its own doc
 * comment. */
const PROFILE_STATE_FILE_NAME = ".claude.json";

/**
 * Test seam: the shape `ccp login` (src/cli.ts) invokes after a successful login — matching
 * {@link seedOnboardingState}'s own signature, the same "inject the bare function" convention
 * `CommandRunner` (command-runner.ts) already uses. Defaults to the real {@link seedOnboardingState}.
 */
export type OnboardingSeeder = (installStateFilePath: string, configDir: string) => Promise<OnboardingSeedResult>;

/** Outcome of one {@link seedOnboardingState} call. */
export interface OnboardingSeedResult {
  /** Whether the Profile's `.claude.json` was actually written. */
  seeded: boolean;
  /** Present when `seeded` is false, naming why — informational only. Every case here is
   * ordinary, expected state (a not-yet-onboarded Default install, an already-onboarded Profile,
   * a source file this project doesn't recognize), never a reason for `ccp login` to fail or even
   * warn; see {@link seedOnboardingState}'s own doc comment. */
  reason?: string;
}

/**
 * Copies `hasCompletedOnboarding` and `lastOnboardingVersion` from the Default install's own
 * `.claude.json` — at `installStateFilePath`, a full file path rather than a directory, since this
 * file lives at the literal home-directory root (`~/.claude.json`), *not* inside `~/.claude`
 * (`defaultInstallDir` in src/cli.ts, the separate directory ADR-0007's Rig is shared from) — into
 * `configDir`'s own, so a freshly logged-in Profile's first *interactive* `claude` launch skips
 * the one-time onboarding wizard ADR-0008 documents. Issue #27's "pre-seed the flag" option,
 * verified viable by probe (see ADR-0008's amendment).
 *
 * Deliberately narrow: only ever touches these two keys, never anything else in either file, and
 * only ever merges into a `configDir/.claude.json` that already exists — the shape `ccp login`
 * always finds there once {@link ClaudePort.login} (the real `claude auth login`) has already
 * run, since that call is what creates the file in the first place, directly inside the bound
 * `CLAUDE_CONFIG_DIR` (confirmed by probe — unlike the Default install's own copy, see above).
 * Never fabricates one: this project delegates that entirely to `claude` (ADR-0001), and inventing
 * a minimal file here would go beyond the two-field scope this exception was accepted for.
 *
 * Best-effort by design, in every direction: a source that isn't there, isn't onboarded itself
 * yet, or doesn't parse — and a destination that doesn't exist or already carries a different
 * shape — all resolve `{ seeded: false }` rather than throwing. This project never treats Claude
 * Code's own undocumented state file the way it treats files it owns (registry.ts, settings.ts,
 * which throw on malformed content because that indicates *this tool's own* output is broken).
 * Here the file is somebody else's, and ADR-0008 already names the risk of a future Claude Code
 * release reshaping it — the correct response to that is silently doing nothing, exactly the
 * manual-step fallback that predates this function, never a failed `ccp login`. This is also why
 * reads here swallow every failure, not just `ENOENT` (unlike registry.ts/settings.ts's stricter
 * narrowing via `isErrnoException`): a permission error reading Claude Code's own file is still
 * just "nothing to seed," not something worth surfacing from a nicety.
 *
 * Idempotent: a Profile that already has `hasCompletedOnboarding: true` — because it completed the
 * wizard for real, or a previous `ccp login` already seeded it — is left untouched rather than
 * overwritten with whatever the Default install currently holds.
 */
export async function seedOnboardingState(installStateFilePath: string, configDir: string): Promise<OnboardingSeedResult> {
  const source = await readOnboardingFields(installStateFilePath);
  if (!source) {
    return { seeded: false, reason: "the Default install hasn't completed onboarding itself yet" };
  }

  const targetPath = join(configDir, PROFILE_STATE_FILE_NAME);
  const target = await readJsonObjectOrUndefined(targetPath);
  if (target === undefined) {
    return { seeded: false, reason: `'${targetPath}' doesn't exist yet` };
  }

  if (target.hasCompletedOnboarding === true) {
    return { seeded: false, reason: "this Profile has already completed onboarding" };
  }

  const merged = {
    ...target,
    hasCompletedOnboarding: source.hasCompletedOnboarding,
    lastOnboardingVersion: source.lastOnboardingVersion,
  };
  await writeFile(targetPath, `${JSON.stringify(merged, null, 2)}\n`, "utf8");

  return { seeded: true };
}

/**
 * Whether {@link seedOnboardingState} would currently find anything to copy from the Default
 * install's own `.claude.json` — the *source* half of pre-seeding, independent of any particular
 * Profile's target file. `ccp doctor`'s Onboarding pre-seeding Check (ticket #33) reports this so
 * a user can tell in advance whether a freshly logged-in Profile's first interactive `claude`
 * launch will skip the onboarding wizard, without needing an actual Profile to try it on.
 */
export async function onboardingSourceReady(installStateFilePath: string): Promise<boolean> {
  return (await readOnboardingFields(installStateFilePath)) !== undefined;
}

/** The two fields {@link seedOnboardingState} copies — present and correctly shaped, or not
 * copied at all; there is no partial case. */
interface OnboardingFields {
  hasCompletedOnboarding: true;
  lastOnboardingVersion: string;
}

async function readOnboardingFields(path: string): Promise<OnboardingFields | undefined> {
  const parsed = await readJsonObjectOrUndefined(path);
  if (parsed === undefined) return undefined;
  if (parsed.hasCompletedOnboarding !== true) return undefined;
  if (typeof parsed.lastOnboardingVersion !== "string") return undefined;

  return { hasCompletedOnboarding: true, lastOnboardingVersion: parsed.lastOnboardingVersion };
}

/** Reads and parses `path` as a JSON object, resolving `undefined` for anything that isn't
 * cleanly that — missing, unreadable, not valid JSON, or not an object — rather than throwing.
 * Unlike registry.ts/settings.ts's `readJsonObjectOrDefault`, which throws on malformed content
 * because that content is this tool's own, every file this function reads belongs to Claude Code
 * — see {@link seedOnboardingState}'s doc comment for why that difference is deliberate. */
async function readJsonObjectOrUndefined(path: string): Promise<Record<string, unknown> | undefined> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return undefined;
  }

  try {
    const parsed = JSON.parse(raw);
    return isPlainObject(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}
