import { resolveBinding } from "../binding.js";
import type { AuthStatus } from "../claude-port.js";
import type { CliDeps, Command } from "../cli-deps.js";
import { errorMessage, reportError } from "../fs-utils.js";
import { compareToExpected, formatIdentity, formatLiveIdentity, NOT_LOGGED_IN, UNKNOWN } from "../identity.js";
import {
  addProfile,
  DEFAULT_INSTALL_ALIAS,
  loadRegistry,
  recordExpectedIdentity,
} from "../registry.js";
import { resolveKnownProfile } from "./shared.js";

const LOGIN_USAGE = "Usage: ccp login <alias>";
const RECONCILE_USAGE = "Usage: ccp reconcile <alias>";
const NEVER_LOGGED_IN = "(never logged in)";
const DRIFTED_MARKER = "[DRIFTED]";

/** Identity reporting and resolution: `whoami`, `login`, `reconcile`, `ls` (ADR-0015). */
export const IDENTITY_COMMANDS: Record<string, Command> = {
  whoami: runWhoami,
  login: runLogin,
  reconcile: runReconcile,
  ls: runLs,
};

/**
 * `ccp whoami`: reports the bound Profile's Alias and the Account/Organization it resolves to.
 * An unbound shell reports the Default install's identity under the `(default)` Alias — never a
 * blank — since under ADR-0003 unbound means the Default install, not "no identity".
 */
async function runWhoami(_args: string[], deps: CliDeps): Promise<number> {
  const binding = resolveBinding(deps.env);
  const alias = binding.bound ? binding.alias : DEFAULT_INSTALL_ALIAS;
  const configDir = binding.bound ? binding.configDir : undefined;

  let status: AuthStatus;
  try {
    status = await deps.claudePort.authStatus(configDir);
  } catch (err) {
    return reportError(deps.stderr, err);
  }

  deps.stdout(formatIdentityReport(alias, status));
  return 0;
}

/**
 * `ccp login <alias>`: triggers Anthropic's own interactive login flow (it opens a browser),
 * scoped to the named Profile's own config directory, then records the resulting Account and
 * Organization as that Profile's expected identity (ADR-0006). Never called by any other
 * command — Login stays explicit precisely because it opens a browser (CONTEXT.md's Login).
 *
 * `alias` need not have gone through `ccp add` beforehand — an alias with no existing registry
 * entry is provisioned by `addProfile` on the spot, so `ccp login` still works standalone. An
 * alias `ccp add` already created is reused as-is, so logging in never disturbs a Profile's
 * existing (and possibly already-populated) registry entry beyond its Expected identity.
 *
 * Also attempts to pre-seed the Profile's onboarding state (issue #27, ADR-0008's amendment) right
 * after `login` succeeds, so the Profile's first *interactive* `claude` launch skips the one-time
 * onboarding wizard instead of requiring it as a separate manual step. Best-effort: a failure here
 * only ever warns, never fails `ccp login` itself, since {@link seedOnboardingState} touches
 * Claude Code's own undocumented state file rather than anything this tool owns.
 */
async function runLogin(args: string[], deps: CliDeps): Promise<number> {
  const alias = args[0];
  if (!alias) {
    deps.stderr(LOGIN_USAGE);
    return 1;
  }

  let configDir: string;
  try {
    const registry = await loadRegistry(deps.stateDir);
    const existing = registry.profiles[alias];
    configDir = existing ? existing.configDir : (await addProfile(deps.stateDir, alias, deps.installDir)).configDir;
  } catch (err) {
    return reportError(deps.stderr, err);
  }

  try {
    await deps.claudePort.login(configDir);
  } catch (err) {
    return reportError(deps.stderr, err);
  }

  try {
    await deps.onboardingSeeder(deps.installStateFilePath, configDir);
  } catch (err) {
    deps.stderr(`Warning: could not pre-seed onboarding state for '${alias}': ${errorMessage(err)}`);
  }

  let status: AuthStatus;
  try {
    status = await deps.claudePort.authStatus(configDir);
  } catch (err) {
    return reportError(deps.stderr, err);
  }

  if (!status.loggedIn) {
    deps.stderr(`'${alias}' finished the login flow but is still not logged in.`);
    return 1;
  }

  // `identity: null` is permitted by AuthStatus's shape (ADR-0014), even though the real `claude
  // auth status --json` never actually omits either field. Recording a placeholder in their place
  // would fabricate Expected identity data instead of honestly reporting the gap, so this fails
  // loudly rather than persisting anything.
  if (status.identity === null) {
    deps.stderr(`'${alias}' logged in, but claude did not report an Account email or Organization — nothing was recorded.`);
    return 1;
  }

  await recordExpectedIdentity(deps.stateDir, alias, status.identity);

  deps.stdout(formatIdentityReport(alias, status));
  return 0;
}

/**
 * `ccp reconcile <alias>`: Reconciliation (CONTEXT.md) — accepts a Profile's currently observed
 * identity as truth and records it as the new Expected identity, resolving Drift. Reads identity
 * the exact same way Drift detection does, via {@link ClaudePort.authStatus}; never calls
 * {@link ClaudePort.login}, so it can never re-authenticate or open a browser, per ticket #8's
 * acceptance criteria.
 */
async function runReconcile(args: string[], deps: CliDeps): Promise<number> {
  const alias = args[0];
  if (!alias) {
    deps.stderr(RECONCILE_USAGE);
    return 1;
  }

  const record = await resolveKnownProfile(deps, alias);
  if (!record) return 1;

  let status: AuthStatus;
  try {
    status = await deps.claudePort.authStatus(record.configDir);
  } catch (err) {
    return reportError(deps.stderr, err);
  }

  if (!status.loggedIn) {
    deps.stderr(`Cannot reconcile '${alias}': it is not logged in, so there is no observed identity to accept as truth.`);
    return 1;
  }
  if (status.identity === null) {
    deps.stderr(`Cannot reconcile '${alias}': claude did not report an Account email or Organization.`);
    return 1;
  }

  await recordExpectedIdentity(deps.stateDir, alias, status.identity);

  deps.stdout(`Reconciled '${alias}': Expected identity is now ${formatIdentity(status.identity)}.`);
  return 0;
}

/**
 * `ccp ls`: lists every managed Profile with its recorded Expected identity, or an explicit
 * never-logged-in state (CONTEXT.md's Login hasn't happened yet for any Profile this tool can
 * create), followed by the Default install's row. Per ADR-0003, that row is never migrated or
 * mutated and must show its real, live identity rather than a blank — the whole reason `ccp ls`
 * exists is to stop the expensive account from being used by accident.
 *
 * A managed Profile's row also marks Drift (ticket #8) distinctly when the registry's stored
 * `drifted` flag — set the last time `ccp use` checked it — is `true`. This never triggers its
 * own {@link ClaudePort.authStatus} call per Profile: the reported state is stored identity,
 * presented honestly as such, not a live re-check that a token still works.
 */
async function runLs(_args: string[], deps: CliDeps): Promise<number> {
  let profiles;
  try {
    profiles = (await loadRegistry(deps.stateDir)).profiles;
  } catch (err) {
    return reportError(deps.stderr, err);
  }

  const lines = Object.entries(profiles)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([alias, record]) => {
      const identity = record.expectedIdentity ? formatIdentity(record.expectedIdentity) : NEVER_LOGGED_IN;
      const driftMarker = record.drifted ? ` ${DRIFTED_MARKER}` : "";
      return `${alias}: ${identity}${driftMarker}`;
    });

  let defaultStatus: AuthStatus;
  try {
    defaultStatus = await deps.claudePort.authStatus();
  } catch (err) {
    return reportError(deps.stderr, err);
  }

  lines.push(`${DEFAULT_INSTALL_ALIAS}: ${formatLiveIdentity(defaultStatus)} [unmanaged]`);

  deps.stdout(lines.join("\n"));
  return 0;
}

/**
 * Renders an identity report shared by `whoami` and `login`. Account/Organization fall back to
 * an explicit `(not logged in)` — a Profile can be Bound but not logged in (CONTEXT.md's Login)
 * — rather than ever printing a blank. A logged-in status with `identity: null` (permitted by
 * {@link AuthStatus}'s shape, even though the real `claude auth status --json` always supplies
 * both halves — ADR-0014) falls back to `(unknown)` instead: reusing `(not logged in)` there
 * would be an outright false statement, not an honest fallback.
 *
 * Distinct from `identity.ts`'s {@link formatIdentity}: this also names the Alias and lays the
 * pair out across separate lines, rather than rendering the "email (orgName)" shape that function
 * owns.
 */
function formatIdentityReport(alias: string, status: AuthStatus): string {
  const account = !status.loggedIn ? NOT_LOGGED_IN : status.identity?.email ?? UNKNOWN;
  const organization = !status.loggedIn ? NOT_LOGGED_IN : status.identity?.orgName ?? UNKNOWN;
  return [`Alias:        ${alias}`, `Account:      ${account}`, `Organization: ${organization}`].join("\n");
}
