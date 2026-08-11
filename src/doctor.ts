import { constants } from "node:fs";
import { access, readdir, readFile, stat } from "node:fs/promises";
import { delimiter, dirname, join } from "node:path";
import type { ClaudePort } from "./claude-port.js";
import { isErrnoException } from "./fs-utils.js";
import { onboardingSourceReady } from "./onboarding.js";
import { RIG_ITEMS } from "./rig.js";

/**
 * The exact guarded line Setup (CONTEXT.md) adds to a `.zshrc` — README.md's install
 * instructions, ADR-0004's Amendment 1 (issue #32). `ccp doctor`'s Shell wiring Check looks for
 * this precise text and prints it verbatim when it's missing, so what a user is told to add is
 * exactly what Setup would have added — one source of truth for the line, not two.
 */
export const SHELL_WIRING_LINE = 'if command -v ccp >/dev/null 2>&1; then eval "$(command ccp shell-init)"; fi';

/** The state directory's name from before the rename (issue #31): `~/.ccacct`, now `~/.ccp`. The
 * Legacy state directory Check looks for a directory under this old name — detection only, never
 * migration (CONTEXT.md's Setup). */
export const LEGACY_STATE_DIR_NAME = ".ccacct";

/** One Check's outcome (CONTEXT.md's **Check**): the Contract it verified, by name, and what it
 * found. `ccp doctor` (ticket #33) reports every Check through this shape. */
export interface CheckReport {
  contract: string;
  finding: string;
}

/**
 * Every input a Check might need, gathered once so {@link runDoctorChecks} can hand each Check
 * exactly what it asks for — the same "explicit inputs, no ambient default inside the module"
 * convention `rig.ts` and `registry.ts` already follow for `installDir`/`stateDir`.
 */
export interface DoctorContext {
  env: NodeJS.ProcessEnv;
  claudePort: ClaudePort;
  /** The tool's own state directory (see `defaultStateDir` in `src/cli.ts`). */
  stateDir: string;
  /** The Default install's configuration directory (ADR-0007). */
  installDir: string;
  /** The Default install's own `.claude.json` — a sibling file, not something inside
   * `installDir` (see `defaultInstallStateFilePath` in `src/cli.ts`). */
  installStateFilePath: string;
  /** Where a state directory under the pre-rename name (issue #31) would live. */
  legacyStateDir: string;
  /** The `.zshrc` a real interactive zsh reads. */
  zshrcPath: string;
}

/**
 * Runs every Check that costs no per-Profile process spawn — ticket #33's scope; the identity
 * Checks, which spawn one process per Profile to compare each against its Expected identity,
 * follow in a later ticket — and resolves each one's {@link CheckReport}.
 *
 * Every Check is independent, and none of them can take the rest of the run down: an unexpected
 * error inside one is caught and turned into that Check's own finding (`guarded` below), the same
 * posture `ccp sync` already takes toward one broken Profile not stopping the others.
 *
 * Reports only. Like every Check in this project, it never repairs anything — that stays with
 * `ccp sync` (CONTEXT.md's Check) — and it never writes to disk: every filesystem call here is a
 * read (`stat`, `readdir`, `readFile`) or a permission probe (`access`), never a write, a
 * `mkdir`, or a `rm`.
 */
export async function runDoctorChecks(ctx: DoctorContext): Promise<CheckReport[]> {
  return [
    await guarded("claude on PATH", () => checkClaudeOnPath(ctx.env)),
    await guarded("Claude Code version", () => checkClaudeVersion(ctx.claudePort)),
    await guarded("Default install", () => checkDefaultInstall(ctx.installDir)),
    await guarded("Rig", () => checkRig(ctx.installDir)),
    await guarded("Onboarding pre-seeding", () => checkOnboardingPreseed(ctx.installStateFilePath)),
    await guarded("State directory", () => checkStateDirWritable(ctx.stateDir)),
    await guarded("Legacy state directory", () => checkLegacyStateDir(ctx.legacyStateDir, ctx.stateDir)),
    await guarded("Shell wiring", () => checkShellWiring(ctx.zshrcPath)),
  ];
}

async function guarded(contract: string, run: () => Promise<string>): Promise<CheckReport> {
  try {
    return { contract, finding: await run() };
  } catch (err) {
    return { contract, finding: `could not be checked: ${errorMessage(err)}` };
  }
}

const CLAUDE_EXECUTABLE = "claude";

/**
 * Whether `claude` is directly runnable from `env.PATH` — scanned directory by directory for an
 * executable file named `claude`, never by spawning a process (no `which`, no `command -v`), so
 * this Check costs nothing even if it's run often. `PATH` is `:`-delimited, matching this
 * project's platform scope (CONTEXT.md's Out of Scope: macOS/zsh only).
 */
async function checkClaudeOnPath(env: NodeJS.ProcessEnv): Promise<string> {
  const dirs = (env.PATH ?? "").split(delimiter).filter((dir) => dir.length > 0);

  for (const dir of dirs) {
    try {
      await access(join(dir, CLAUDE_EXECUTABLE), constants.X_OK);
      return "found on PATH";
    } catch {
      // Deliberately broad, unlike isDirectory/readFileOrEmpty below: this is a multi-candidate
      // scan across every PATH entry, not a single path's existence check, so one directory
      // erroring (permission or otherwise) must never stop the search through the rest of PATH.
      // Not here — keep looking.
    }
  }

  return "not found on PATH — install Claude Code, or add its location to PATH, before relying on ccp";
}

/** Reports the version {@link ClaudePort.version} resolves, or the failure to resolve one — never
 * throws, so a `claude` that's missing or produces something unexpected shows up as this Check's
 * own finding rather than aborting the rest of the report. */
async function checkClaudeVersion(claudePort: ClaudePort): Promise<string> {
  try {
    return await claudePort.version();
  } catch (err) {
    return `could not be determined: ${errorMessage(err)}`;
  }
}

async function checkDefaultInstall(installDir: string): Promise<string> {
  const present = await isDirectory(installDir);
  return present
    ? `found at ${installDir}`
    : `not found at ${installDir} — an absent Default install means an empty Rig and no onboarding pre-seeding`;
}

const KNOWN_RIG_ITEMS = new Set<string>(RIG_ITEMS);

/**
 * Diffs the Default install's top-level entries against {@link RIG_ITEMS} and names anything
 * unrecognised — how a newly-invented kind of Claude Code configuration becomes visible instead
 * of being silently unshared (issue #28). Only ever reports this direction: a known Rig item
 * that's absent from the Default install is ordinary, already-established behaviour (Spike 0001,
 * ADR-0007's `shareRig`/`repairRig`) and is never named here.
 */
async function checkRig(installDir: string): Promise<string> {
  let entries: string[];
  try {
    entries = await readdir(installDir);
  } catch (err) {
    if (!isErrnoException(err) || err.code !== "ENOENT") throw err;
    return "skipped — the Default install is absent";
  }

  const unrecognised = entries.filter((entry) => !KNOWN_RIG_ITEMS.has(entry)).sort((a, b) => a.localeCompare(b));

  return unrecognised.length === 0
    ? "every top-level entry under the Default install is a known Rig item"
    : `unrecognised top-level entries under the Default install: ${unrecognised.join(", ")}`;
}

async function checkOnboardingPreseed(installStateFilePath: string): Promise<string> {
  const ready = await onboardingSourceReady(installStateFilePath);
  return ready
    ? "would currently work — the Default install has completed onboarding"
    : "would not currently work — the Default install hasn't completed onboarding itself yet";
}

/**
 * Checks that {@link stateDir} is writable — by permission probe (`access`, `constants.W_OK`),
 * never by writing anything, so this Check itself can never be the thing that leaves a stray file
 * behind. A state directory that doesn't exist yet is ordinary before a first `ccp add`/`ccp
 * login` (`addProfile`'s own `mkdir`, `registry.ts`'s `saveRegistry`), so this falls back to
 * probing its parent directory instead — the permission that actually decides whether creating it
 * later would succeed.
 */
async function checkStateDirWritable(stateDir: string): Promise<string> {
  try {
    await access(stateDir, constants.W_OK);
    return `writable (${stateDir})`;
  } catch (err) {
    if (!isErrnoException(err) || err.code !== "ENOENT") {
      return `not writable at ${stateDir}: ${errorMessage(err)}`;
    }
  }

  try {
    await access(dirname(stateDir), constants.W_OK);
    return `does not exist yet at ${stateDir}, but its parent directory is writable — it will be created on first use`;
  } catch (err) {
    return `does not exist yet at ${stateDir}, and its parent directory is not writable: ${errorMessage(err)}`;
  }
}

/**
 * Detects a state directory under the pre-rename name (issue #31) and prints the single move
 * command that resolves it — detection only, never moving anything itself, so the rename can
 * never silently orphan a Profile registry someone hasn't moved yet.
 */
async function checkLegacyStateDir(legacyStateDir: string, currentStateDir: string): Promise<string> {
  const present = await isDirectory(legacyStateDir);
  return present
    ? `found at ${legacyStateDir}, from before the rename (issue #31) — resolve it with: mv ${legacyStateDir} ${currentStateDir}`
    : "none found";
}

/**
 * Detects whether {@link SHELL_WIRING_LINE} is present in `zshrcPath`, printing the exact line to
 * add when it's not. A missing file reads the same as one without the line — nothing to find, not
 * an error — but only `ENOENT` is treated that way: any other failure to read it (e.g. a
 * permission error) is rethrown rather than misreported as "missing", matching
 * `registry.ts`/`rig.ts`/`settings.ts`'s narrow-and-rethrow posture for a real error versus
 * `onboarding.ts`'s broader swallow, which is reserved for cases explicitly argued as best-effort.
 * `runDoctorChecks`'s `guarded` wrapper turns a rethrown error into this Check's own
 * "could not be checked" finding, so nothing here can take the rest of the report down.
 */
async function checkShellWiring(zshrcPath: string): Promise<string> {
  const content = await readFileOrEmpty(zshrcPath);

  return content.includes(SHELL_WIRING_LINE)
    ? `present in ${zshrcPath}`
    : `missing from ${zshrcPath} — add this line:\n  ${SHELL_WIRING_LINE}`;
}

async function readFileOrEmpty(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (err) {
    if (isErrnoException(err) && err.code === "ENOENT") return "";
    throw err;
  }
}

/**
 * Whether `path` is a directory that exists — `false` for "doesn't exist" (`ENOENT`), never for
 * any other failure, which is rethrown instead. Same rationale as {@link checkShellWiring}:
 * "absent" and "errored trying to check" are different findings, and only `guarded` (in
 * {@link runDoctorChecks}) gets to decide that the latter still shouldn't abort the rest of the
 * report.
 */
async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch (err) {
    if (isErrnoException(err) && err.code === "ENOENT") return false;
    throw err;
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
