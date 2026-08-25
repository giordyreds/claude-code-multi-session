import { constants } from "node:fs";
import { access, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { delimiter, dirname, join } from "node:path";
import type { AuthStatus, ClaudePort } from "./claude-port.js";
import { errorMessage, isErrnoException, isPlainObject } from "./fs-utils.js";
import { formatIdentity, identityKey, type Identity } from "./identity.js";
import { onboardingSourceReady } from "./onboarding.js";
import { loadRegistry } from "./registry.js";
import { RIG_ITEMS } from "./rig.js";

/**
 * The exact guarded line Setup (CONTEXT.md) adds to a shell startup file (`.zshrc` or `.bashrc`,
 * see `defaultShellRcPath`, `src/cli.ts`, issue #40) — README.md's install instructions,
 * ADR-0004's Amendment 1 (issue #32). `ccp doctor`'s Shell wiring Check looks for this precise
 * text and prints it verbatim when it's missing, so what a user is told to add is exactly what
 * Setup would have added — one source of truth for the line, not two. Plain POSIX `sh`, needing
 * no bash/zsh distinction of its own.
 */
export const SHELL_WIRING_LINE = 'if command -v ccp >/dev/null 2>&1; then eval "$(command ccp shell-init)"; fi';

/** The state directory's name from before the rename (issue #31): `~/.ccacct`, now `~/.ccp`. The
 * Legacy state directory Check looks for a directory under this old name — detection only, never
 * migration (CONTEXT.md's Setup). */
export const LEGACY_STATE_DIR_NAME = ".ccacct";

/** One Check's outcome (CONTEXT.md's **Check**): the Contract it verified, by name, what it
 * found, and whether it found a problem. `ccp doctor` (ticket #33) reports every Check through
 * this shape; `runDoctor` (`src/cli.ts`, issue #34) also reads `ok` across every report to decide
 * whether this run actually verified anything worth recording as a Claude Code version — see
 * {@link recordVerifiedVersion}'s doc comment. */
export interface CheckReport {
  contract: string;
  finding: string;
  ok: boolean;
}

/** What one Check function itself resolves, before {@link guarded} turns it into a
 * {@link CheckReport} — kept private since nothing outside this module needs a finding without
 * its Contract name attached. */
interface CheckOutcome {
  finding: string;
  ok: boolean;
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
  /** The shell startup file a user's actual interactive shell reads — `~/.zshrc`/
   * `$ZDOTDIR/.zshrc` for zsh, `~/.bashrc` for everything else (see `defaultShellRcPath`,
   * `src/cli.ts`, issue #40). */
  shellRcPath: string;
}

/**
 * Runs every Check `ccp doctor` reports, including the identity Check (issue #34) that spawns one
 * process per registered Profile to compare its observed identity against its Expected identity —
 * the only Check with that cost, which is exactly why it lives here and never on the Binding path
 * (ADR-0010, `src/binding.ts`) — and resolves each one's {@link CheckReport}.
 *
 * Every Check is independent, and none of them can take the rest of the run down: an unexpected
 * error inside one is caught and turned into that Check's own finding (`guarded` below), the same
 * posture `ccp sync` already takes toward one broken Profile not stopping the others.
 *
 * Reports only. Like every Check in this project, it never repairs anything — that stays with
 * `ccp sync` (CONTEXT.md's Check) — and it never writes to disk: every filesystem call here is a
 * read (`stat`, `readdir`, `readFile`) or a permission probe (`access`), never a write, a
 * `mkdir`, or a `rm`. Recording the Claude Code version this run last saw (ADR-0010's "honest
 * replacement for a matrix") is therefore deliberately kept out of this function — it's the one
 * genuine write in `ccp doctor`'s path, and it happens in `runDoctor` (`src/cli.ts`) instead, via
 * {@link recordVerifiedVersion}, so this function's own "never writes to disk" stays true and
 * directly tested (see `doctor.test.ts`) rather than merely assumed.
 *
 * Each {@link CheckReport}'s `ok` reports whether that one Check found a problem — `runDoctor`
 * reads it across every report to decide whether *this run* actually passed, i.e. whether the
 * version it just saw is honestly one this machine has verified (issue #34's "the version its
 * Checks last **passed** against", not merely "ran against").
 */
export async function runDoctorChecks(ctx: DoctorContext): Promise<CheckReport[]> {
  return [
    await guarded(CONTRACT_CLAUDE_ON_PATH, () => checkClaudeOnPath(ctx.env)),
    await guarded("Claude Code version", () => checkClaudeVersion(ctx.claudePort)),
    await guarded("Default install", () => checkDefaultInstall(ctx.installDir)),
    await guarded("Rig", () => checkRig(ctx.installDir)),
    await guarded("Onboarding pre-seeding", () => checkOnboardingPreseed(ctx.installStateFilePath)),
    await guarded(CONTRACT_STATE_DIRECTORY, () => checkStateDirWritable(ctx.stateDir)),
    await guarded("Legacy state directory", () => checkLegacyStateDir(ctx.legacyStateDir, ctx.stateDir)),
    await guarded("Shell wiring", () => checkShellWiring(ctx.shellRcPath)),
    await guarded("Identity isolation", () => checkIdentityIsolation(ctx.stateDir, ctx.claudePort)),
  ];
}

/**
 * The two Contract names {@link CheckReport} reports that `ccp setup` (issue #35, `src/cli.ts`)
 * treats as fatal — exported as constants, rather than left as string literals `runSetup` would
 * have to retype, so a rename of either Check's name here can never silently desync from the rule
 * that reads it.
 */
export const CONTRACT_CLAUDE_ON_PATH = "claude on PATH";
export const CONTRACT_STATE_DIRECTORY = "State directory";

async function guarded(contract: string, run: () => Promise<CheckOutcome>): Promise<CheckReport> {
  try {
    const { finding, ok } = await run();
    return { contract, finding, ok };
  } catch (err) {
    return { contract, finding: `could not be checked: ${errorMessage(err)}`, ok: false };
  }
}

const CLAUDE_EXECUTABLE = "claude";

/**
 * Whether `claude` is directly runnable from `env.PATH` — scanned directory by directory for an
 * executable file named `claude`, never by spawning a process (no `which`, no `command -v`), so
 * this Check costs nothing even if it's run often. `PATH` is `:`-delimited on every platform
 * `ccp` supports — macOS and Linux alike (issue #40, ADR-0012); Windows never reaches this Check
 * at all, guarded out earlier in `runCli` (`src/cli.ts`).
 *
 * Reports *which* file it found, not merely that it found one (ADR-0013). Two `claude` installs on
 * one machine are ordinary — a Homebrew one shadowing an npm one, say — and a Check that says only
 * "found" can't tell you which one every other Check then went on to observe. Under WSL the same
 * finding does a second job for free: `PATH` interop puts the Windows-side install on `PATH` as
 * `/mnt/c/…/claude`, and a Windows process can't interpret the Linux `CLAUDE_CONFIG_DIR` that
 * Binding hands it — a Phantom binding (CONTEXT.md). Naming the path makes that visible without a
 * WSL-aware branch, which ADR-0012's universal-detection principle is the reason not to add.
 */
async function checkClaudeOnPath(env: NodeJS.ProcessEnv): Promise<CheckOutcome> {
  const dirs = (env.PATH ?? "").split(delimiter).filter((dir) => dir.length > 0);

  for (const dir of dirs) {
    const candidate = join(dir, CLAUDE_EXECUTABLE);
    try {
      await access(candidate, constants.X_OK);
      return { finding: `found at ${candidate}`, ok: true };
    } catch {
      // Deliberately broad, unlike isDirectory/readFileOrEmpty below: this is a multi-candidate
      // scan across every PATH entry, not a single path's existence check, so one directory
      // erroring (permission or otherwise) must never stop the search through the rest of PATH.
      // Not here — keep looking.
    }
  }

  return {
    finding: "not found on PATH — install Claude Code, or add its location to PATH, before relying on ccp",
    ok: false,
  };
}

/** Either the Claude Code version {@link ClaudePort.version} resolved, or the failure to resolve
 * one — shared by {@link checkClaudeVersion} (which formats it into a finding) and `runDoctor`
 * (`src/cli.ts`, which needs the raw version itself to record it — see
 * {@link recordVerifiedVersion}) so both read `claude --version` through the exact same call
 * rather than one of them re-deriving success from the other's already-formatted string. */
export type ClaudeVersionResolution = { ok: true; version: string } | { ok: false; error: string };

/** Resolves `claude --version` through {@link ClaudePort.version} — never throws. */
export async function resolveClaudeVersion(claudePort: ClaudePort): Promise<ClaudeVersionResolution> {
  try {
    return { ok: true, version: await claudePort.version() };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}

/** Reports the version {@link resolveClaudeVersion} resolves, or the failure to resolve one —
 * never throws, so a `claude` that's missing or produces something unexpected shows up as this
 * Check's own finding rather than aborting the rest of the report. */
async function checkClaudeVersion(claudePort: ClaudePort): Promise<CheckOutcome> {
  const result = await resolveClaudeVersion(claudePort);
  return result.ok
    ? { finding: result.version, ok: true }
    : { finding: `could not be determined: ${result.error}`, ok: false };
}

async function checkDefaultInstall(installDir: string): Promise<CheckOutcome> {
  const present = await isDirectory(installDir);
  return present
    ? { finding: `found at ${installDir}`, ok: true }
    : {
        finding: `not found at ${installDir} — an absent Default install means an empty Rig and no onboarding pre-seeding`,
        ok: false,
      };
}

const KNOWN_RIG_ITEMS = new Set<string>(RIG_ITEMS);

/**
 * Diffs the Default install's top-level entries against {@link RIG_ITEMS} and names anything
 * unrecognised — how a newly-invented kind of Claude Code configuration becomes visible instead
 * of being silently unshared (issue #28). Only ever reports this direction: a known Rig item
 * that's absent from the Default install is ordinary, already-established behaviour (Spike 0001,
 * ADR-0007's `shareRig`/`repairRig`) and is never named here.
 */
async function checkRig(installDir: string): Promise<CheckOutcome> {
  let entries: string[];
  try {
    entries = await readdir(installDir);
  } catch (err) {
    if (!isErrnoException(err) || err.code !== "ENOENT") throw err;
    // The Default install's own absence is already named by "Default install"'s own Check —
    // this Check found nothing unrecognised itself, so it's not this Check's own problem to
    // report a second time.
    return { finding: "skipped — the Default install is absent", ok: true };
  }

  const unrecognised = entries.filter((entry) => !KNOWN_RIG_ITEMS.has(entry)).sort((a, b) => a.localeCompare(b));

  return unrecognised.length === 0
    ? { finding: "every top-level entry under the Default install is a known Rig item", ok: true }
    : { finding: `unrecognised top-level entries under the Default install: ${unrecognised.join(", ")}`, ok: false };
}

async function checkOnboardingPreseed(installStateFilePath: string): Promise<CheckOutcome> {
  const ready = await onboardingSourceReady(installStateFilePath);
  return ready
    ? { finding: "would currently work — the Default install has completed onboarding", ok: true }
    : { finding: "would not currently work — the Default install hasn't completed onboarding itself yet", ok: false };
}

/**
 * Checks that {@link stateDir} is writable — by permission probe (`access`, `constants.W_OK`),
 * never by writing anything, so this Check itself can never be the thing that leaves a stray file
 * behind. A state directory that doesn't exist yet is ordinary before a first `ccp add`/`ccp
 * login` (`addProfile`'s own `mkdir`, `registry.ts`'s `saveRegistry`), so this falls back to
 * probing its parent directory instead — the permission that actually decides whether creating it
 * later would succeed.
 */
async function checkStateDirWritable(stateDir: string): Promise<CheckOutcome> {
  try {
    await access(stateDir, constants.W_OK);
    return { finding: `writable (${stateDir})`, ok: true };
  } catch (err) {
    if (!isErrnoException(err) || err.code !== "ENOENT") {
      return { finding: `not writable at ${stateDir}: ${errorMessage(err)}`, ok: false };
    }
  }

  try {
    await access(dirname(stateDir), constants.W_OK);
    return {
      finding: `does not exist yet at ${stateDir}, but its parent directory is writable — it will be created on first use`,
      ok: true,
    };
  } catch (err) {
    return {
      finding: `does not exist yet at ${stateDir}, and its parent directory is not writable: ${errorMessage(err)}`,
      ok: false,
    };
  }
}

/**
 * Detects a state directory under the pre-rename name (issue #31) and prints the single move
 * command that resolves it — detection only, never moving anything itself, so the rename can
 * never silently orphan a Profile registry someone hasn't moved yet.
 */
async function checkLegacyStateDir(legacyStateDir: string, currentStateDir: string): Promise<CheckOutcome> {
  const present = await isDirectory(legacyStateDir);
  return present
    ? {
        finding: `found at ${legacyStateDir}, from before the rename (issue #31) — resolve it with: mv ${legacyStateDir} ${currentStateDir}`,
        ok: false,
      }
    : { finding: "none found", ok: true };
}

/**
 * Detects whether {@link SHELL_WIRING_LINE} is present in `shellRcPath`, printing the exact line
 * to add when it's not. A missing file reads the same as one without the line — nothing to find,
 * not an error — but only `ENOENT` is treated that way: any other failure to read it (e.g. a
 * permission error) is rethrown rather than misreported as "missing", matching
 * `registry.ts`/`rig.ts`/`settings.ts`'s narrow-and-rethrow posture for a real error versus
 * `onboarding.ts`'s broader swallow, which is reserved for cases explicitly argued as best-effort.
 * `runDoctorChecks`'s `guarded` wrapper turns a rethrown error into this Check's own
 * "could not be checked" finding, so nothing here can take the rest of the report down.
 */
async function checkShellWiring(shellRcPath: string): Promise<CheckOutcome> {
  return (await shellWiringPresent(shellRcPath))
    ? { finding: `present in ${shellRcPath}`, ok: true }
    : { finding: `missing from ${shellRcPath} — add this line:\n  ${SHELL_WIRING_LINE}`, ok: false };
}

/**
 * Whether {@link SHELL_WIRING_LINE} is already present in `shellRcPath` — the one predicate this
 * Check, `setup.ts`'s write/remove, and `ccp setup`'s `--dry-run` preview (`src/cli.ts`) all need,
 * shared here so "present" can never mean something subtly different at one of those call sites
 * than at another.
 */
export async function shellWiringPresent(shellRcPath: string): Promise<boolean> {
  return (await readFileOrEmpty(shellRcPath)).includes(SHELL_WIRING_LINE);
}

/** Reads `path`, resolving `""` when it doesn't exist rather than throwing — shared with
 * `setup.ts`, which needs the exact same "missing file reads as empty" semantics to decide
 * whether {@link SHELL_WIRING_LINE} is already present before writing or removing it, so Setup
 * and this Check can never disagree about what "present" means. */
export async function readFileOrEmpty(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (err) {
    if (isErrnoException(err) && err.code === "ENOENT") return "";
    throw err;
  }
}

/**
 * The identity Check (issue #34) — the only Check that spawns a process per Profile (ADR-0010),
 * which is why it lives here and never on the Binding path. Resolves every registered Profile's
 * observed identity, in parallel, and looks for the one pattern that actually indicates lost
 * isolation: two or more Profiles that are recorded with *different* Expected identities but
 * currently resolve to the exact *same* observed identity as each other. The config-directory
 * variable was supposed to keep them apart (CONTEXT.md's Contract #3, ADR-0010); if it no longer
 * does, every Profile sharing its neighbour's identity is named.
 *
 * Judging by mere sameness — "do these two Profiles currently match?" — would be wrong on its own
 * (ADR-0010's Consequences): two Profiles legitimately sharing one Account, both still matching
 * their own recorded Expected identity, must never be reported. That case is a group whose members
 * all share one *observed* identity but also all share the same *Expected* identity, so it's
 * distinguished from real isolation loss by requiring the Expected identities within a group to
 * disagree too, not merely the observed ones to coincide.
 *
 * A Profile with no recorded Expected identity yet, or one that isn't currently logged in with
 * both an email and an orgName, has nothing to compare — the same posture `identity.ts`'s
 * `compareToExpected` already takes toward a single Profile — so it's left out of every group
 * entirely rather than counted as a match or a mismatch.
 */
async function checkIdentityIsolation(stateDir: string, claudePort: ClaudePort): Promise<CheckOutcome> {
  const { profiles } = await loadRegistry(stateDir);
  const aliases = Object.keys(profiles).sort((a, b) => a.localeCompare(b));

  const comparable = (
    await Promise.all(
      aliases.map(async (alias) => {
        const record = profiles[alias]!;
        if (!record.expectedIdentity) return undefined;

        const status = await claudePort.authStatus(record.configDir);
        const observed = observedIdentity(status);
        if (!observed) return undefined;

        return { alias, expected: record.expectedIdentity, observed };
      }),
    )
  ).filter((entry): entry is { alias: string; expected: Identity; observed: Identity } => entry !== undefined);

  if (comparable.length === 0) {
    return {
      finding: "no Profile has both a recorded Expected identity and a currently resolvable observed identity to compare",
      ok: true,
    };
  }

  const byObserved = new Map<string, typeof comparable>();
  for (const entry of comparable) {
    const key = identityKey(entry.observed);
    const group = byObserved.get(key);
    if (group) group.push(entry);
    else byObserved.set(key, [entry]);
  }

  const warnings: string[] = [];
  for (const group of byObserved.values()) {
    if (group.length < 2) continue;

    const expectedKeys = new Set(group.map((entry) => identityKey(entry.expected)));
    // Every member shares one observed identity; if their Expected identities agree too, this is
    // Profiles legitimately sharing one Account on purpose — not the pattern this Check exists to
    // catch (the false-positive case tested explicitly, per issue #34's acceptance criteria).
    if (expectedKeys.size <= 1) continue;

    const names = group.map((entry) => `'${entry.alias}' (expected ${formatIdentity(entry.expected)})`).join(", ");
    warnings.push(`${names} all currently resolve to ${formatIdentity(group[0]!.observed)} — isolation may be lost`);
  }

  return warnings.length === 0
    ? { finding: `no signs of lost isolation across ${comparable.length} comparable Profile(s)`, ok: true }
    : { finding: warnings.join("; "), ok: false };
}

/** The Identity `status` reports, or `undefined` when there isn't one to compare — a Profile
 * that's logged out, or one `claude` reports as logged in without naming both halves
 * (`identity: null`, permitted by {@link AuthStatus}'s shape — ADR-0014). */
function observedIdentity(status: AuthStatus): Identity | undefined {
  return status.loggedIn ? status.identity ?? undefined : undefined;
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

/** The file `ccp doctor` records the Claude Code version its Checks last ran against — a small,
 * dedicated state file under the tool's own state directory, deliberately separate from
 * `registry.json` (`registry.ts`): this records what a run of `ccp doctor` last saw on this
 * machine, nothing about any one Profile. */
const VERIFIED_VERSION_FILE_NAME = "verified-version.json";

function verifiedVersionPath(stateDir: string): string {
  return join(stateDir, VERIFIED_VERSION_FILE_NAME);
}

/**
 * Reads the Claude Code version `ccp doctor` last recorded on this machine (ADR-0010) — `null` if
 * it has never recorded one, or if the record can't be read for any reason. A corrupt or missing
 * record is never worth failing `ccp doctor` over: the worst consequence of treating it as `null`
 * is reporting "never recorded" one run too many, which {@link recordVerifiedVersion} then
 * overwrites with a fresh, valid record on this same run.
 */
export async function loadVerifiedVersion(stateDir: string): Promise<string | null> {
  let raw: string;
  try {
    raw = await readFile(verifiedVersionPath(stateDir), "utf8");
  } catch {
    return null;
  }

  try {
    const parsed = JSON.parse(raw);
    return isPlainObject(parsed) && typeof parsed.version === "string" ? parsed.version : null;
  } catch {
    return null;
  }
}

/**
 * Records `version` as the Claude Code version `ccp doctor`'s Checks last **passed** against —
 * the "honest replacement for a matrix" ADR-0010 calls for: an account of what was actually
 * verified on this machine, in place of a table of untested combinations. `runDoctor` (`src/
 * cli.ts`) only calls this when every {@link CheckReport} from the same run reports `ok`, so a run
 * that finds a real problem — lost isolation chief among them — never gets recorded as a version
 * this machine has verified; it falls back to whatever was last actually clean instead (issue
 * #34's "last **passed** against", not merely "last ran against"). The one deliberate write in
 * `ccp doctor`'s path (see {@link runDoctorChecks}'s doc comment) — called only from `runDoctor`,
 * never from here.
 */
export async function recordVerifiedVersion(stateDir: string, version: string): Promise<void> {
  await mkdir(stateDir, { recursive: true });
  await writeFile(verifiedVersionPath(stateDir), `${JSON.stringify({ version }, null, 2)}\n`, "utf8");
}
