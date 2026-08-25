import type { CliDeps, Command } from "../cli-deps.js";
import {
  CONTRACT_CLAUDE_ON_PATH,
  CONTRACT_STATE_DIRECTORY,
  loadVerifiedVersion,
  recordVerifiedVersion,
  resolveClaudeVersion,
  runDoctorChecks,
} from "../doctor.js";
import { reportError } from "../fs-utils.js";
import { removeShellWiringLine, writeShellWiringLine } from "../setup.js";
import { isPresent, SHELL_WIRING_LINE } from "../shell-wiring.js";

/** The two Contract names (`doctor.ts`'s `runDoctorChecks` output) whose own Check failing is the
 * *only* thing allowed to fail `ccp setup` (issue #35's fixed fatal/non-fatal rule) — every other
 * Check's problem is still reported, but Setup succeeds anyway, matching the posture already
 * taken for onboarding pre-seeding: somebody else's Contract changing is not this tool's error.
 * Built from `doctor.ts`'s own exported constants, not retyped string literals, so a rename of
 * either Check's name there can never silently desync from this rule. */
const SETUP_FATAL_CONTRACTS = new Set([CONTRACT_CLAUDE_ON_PATH, CONTRACT_STATE_DIRECTORY]);

/** Machine-wide wiring and health: `setup`, `teardown`, `doctor` (ADR-0015). */
export const MACHINE_COMMANDS: Record<string, Command> = {
  setup: runSetup,
  teardown: runTeardown,
  doctor: runDoctor,
};

/**
 * `ccp setup` (issue #35): the second and last command a new user types. Adds
 * {@link SHELL_WIRING_LINE} to the interactive startup file the user's shell actually reads
 * (`shellRcPath`, resolved the same way `ccp doctor`'s Shell wiring Check reads it — see
 * `cli.ts`'s `defaultShellRcPath`'s universal, `$SHELL`-keyed detection, issue #40), then runs the
 * exact same Checks `ccp doctor` exposes
 * ({@link runDoctorChecks}) so problems surface here, once, rather than later as unexplained
 * failures. One implementation, two entry points — this function never reimplements a Check.
 *
 * `--dry-run` previews the line-writing step only — the machine's state is what it already was,
 * so there is nothing to verify and no Checks run. It prints exactly what would be added (or that
 * there's nothing to add, when the line is already present) and nothing else.
 *
 * Writing the line always happens first, unconditionally, even when a Check that follows turns
 * out to fail Setup: the write is independent of whether `claude` is on `PATH` or the state
 * directory is writable, and the shell wiring line itself is exactly as useful once `claude` is
 * later fixed. Only {@link SETUP_FATAL_CONTRACTS}'s two Contracts fail Setup's own exit code —
 * every other Check's finding is still printed, per issue #35's acceptance criteria that a
 * merely-incomplete machine still ends up wired correctly.
 *
 * Ends by naming the next command to run, unconditionally, per this ticket's own acceptance
 * criteria — success points at `ccp add`; a fatal failure points back at re-running `ccp setup`
 * once the reported problem (a missing `claude`, an unwritable state directory) is fixed, rather
 * than leaving a failed run silent about what to do next.
 */
async function runSetup(args: string[], deps: CliDeps): Promise<number> {
  if (args.includes("--dry-run")) {
    let present: boolean;
    try {
      present = await isPresent(deps.shellRcPath);
    } catch (err) {
      return reportError(deps.stderr, err);
    }

    deps.stdout(
      present
        ? `Dry run: ${deps.shellRcPath} already contains the shell wiring line — nothing to add.`
        : `Dry run: would add the following line to ${deps.shellRcPath}:\n  ${SHELL_WIRING_LINE}`,
    );
    return 0;
  }

  let writeResult: { added: boolean };
  try {
    writeResult = await writeShellWiringLine(deps.shellRcPath);
  } catch (err) {
    return reportError(deps.stderr, err);
  }

  const lines: string[] = [
    writeResult.added
      ? `Added the following line to ${deps.shellRcPath}:\n  ${SHELL_WIRING_LINE}`
      : `${deps.shellRcPath} already contains the shell wiring line — nothing to add.`,
  ];

  const reports = await runDoctorChecks({
    env: deps.env,
    claudePort: deps.claudePort,
    stateDir: deps.stateDir,
    installDir: deps.installDir,
    installStateFilePath: deps.installStateFilePath,
    legacyStateDir: deps.legacyStateDir,
    shellRcPath: deps.shellRcPath,
  });
  for (const report of reports) lines.push(`${report.contract}: ${report.finding}`);

  const fatal = reports.some((report) => SETUP_FATAL_CONTRACTS.has(report.contract) && !report.ok);
  lines.push(
    fatal
      ? "Next: fix the problem reported above, then re-run 'ccp setup'."
      : "Next: run 'ccp add <alias>' to create your first Profile.",
  );

  deps.stdout(lines.join("\n"));
  return fatal ? 1 : 0;
}

/**
 * `ccp teardown`: Setup's inverse (issue #35). Removes only {@link SHELL_WIRING_LINE} from the
 * startup file Setup added it to — leaving every other line in the file untouched, and never
 * touching Profiles, the state directory, or anything else. Safe to run when Setup was never run
 * at all: {@link removeShellWiringLine} reports `removed: false` rather than throwing when
 * there's no line to remove.
 *
 * Always reports what it deliberately left behind — the state directory and the existing
 * per-Profile removal command — so the non-destructive choice this makes is visible rather than
 * silent (this ticket's own acceptance criteria), regardless of whether there was a line to
 * remove this time.
 */
async function runTeardown(_args: string[], deps: CliDeps): Promise<number> {
  let result: { removed: boolean };
  try {
    result = await removeShellWiringLine(deps.shellRcPath);
  } catch (err) {
    return reportError(deps.stderr, err);
  }

  const lines = [
    result.removed
      ? `Removed the shell wiring line from ${deps.shellRcPath}.`
      : `${deps.shellRcPath} had no shell wiring line to remove — nothing to do.`,
    `Left behind on purpose: your Profiles, still under ${deps.stateDir}. Remove one yourself with 'ccp rm <alias> --yes'.`,
  ];

  deps.stdout(lines.join("\n"));
  return 0;
}

/**
 * `ccp doctor` (ticket #33, issue #34): runs every Check — including the identity Check, the only
 * one that spawns a process per Profile (ADR-0010) — and reports each Contract by name alongside
 * what it found (CONTEXT.md's Check). Reports only: like every Check in this project, it never
 * repairs anything — that stays with `ccp sync`.
 *
 * The one deliberate exception to "never writes anything to disk" is this function itself, not
 * {@link runDoctorChecks} (still read-only, still asserted directly by its own tests): once every
 * Check has run, if every single one of them reports `ok` — nothing found on the machine that
 * indicates a Contract broke, isolation included — it records the Claude Code version this run
 * saw as the version its Checks last *passed* against (ADR-0010's "honest replacement for a
 * matrix") via {@link recordVerifiedVersion}. A run that finds even one real problem never
 * overwrites that record — it falls back to whatever was last actually recorded clean, or to
 * "never recorded" if nothing has been — so "Verified against" always names a version this
 * machine actually passed its Checks against, never merely the version it happened to be running
 * during a broken run.
 */
async function runDoctor(_args: string[], deps: CliDeps): Promise<number> {
  const reports = await runDoctorChecks(deps);
  const allChecksClean = reports.every((report) => report.ok);

  const versionResolution = await resolveClaudeVersion(deps.claudePort);
  let verifiedVersion: string | null;
  if (versionResolution.ok && allChecksClean) {
    await recordVerifiedVersion(deps.stateDir, versionResolution.version);
    verifiedVersion = versionResolution.version;
  } else {
    verifiedVersion = await loadVerifiedVersion(deps.stateDir);
  }

  const lines = reports.map((report) => `${report.contract}: ${report.finding}`);
  lines.push(`Verified against: ${verifiedVersion ?? "no version has ever been recorded on this machine"}`);

  deps.stdout(lines.join("\n"));
  return 0;
}
