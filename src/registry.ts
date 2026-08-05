import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isErrnoException } from "./fs-utils.js";
import { shareRig } from "./rig.js";
import { renderSettings } from "./settings.js";

/** The settings file's name, both in the Default install and in every rendered Profile — the one
 * name Claude Code itself reads (ADR-0002). */
const SETTINGS_FILE_NAME = "settings.json";

/** The (Account, Organization) a Profile is recorded as resolving to — see CONTEXT.md's
 * **Expected identity**. `null` until something (`ccp login`, or a future Reconciliation command)
 * records one; that is the ordinary state for every freshly-added Profile. */
export interface ExpectedIdentity {
  email: string;
  orgName: string;
}

/** A managed Profile's registry entry. Alias is the key it's stored under, not a field here —
 * same "no separately stored field" shape ADR-0005 already committed to for the bare Alias. */
export interface ProfileRecord {
  configDir: string;
  expectedIdentity: ExpectedIdentity | null;
  /** Whether Binding last observed this Profile's identity diverging from its Expected identity
   * — see CONTEXT.md's Drift. Recorded here so `ccp ls` (ticket #8) can mark drifted Profiles
   * from stored state alone, without an API call to re-check whether a token still works. */
  drifted: boolean;
}

/** The Profile registry — see ADR-0005's deferred registry file, created by `ccp add` and amended
 * (ADR-0006) to carry Expected identity for `ccp login`. */
export interface Registry {
  profiles: Record<string, ProfileRecord>;
}

/** The Alias `resolveBinding` (src/binding.ts) reports for an unbound shell — reserved so a
 * managed Profile can never collide with `ccp ls`'s synthesized Default-install row. Enforced
 * here, the module that owns Alias validity, not by callers. */
export const DEFAULT_INSTALL_ALIAS = "(default)";

const REGISTRY_FILE_NAME = "registry.json";

function registryPath(stateDir: string): string {
  return join(stateDir, REGISTRY_FILE_NAME);
}

/**
 * Loads the Profile registry from `<stateDir>/registry.json`. A missing file means no Profile has
 * ever been added — an empty registry, not an error. A present-but-broken file is never silently
 * reset (that would quietly forget every registered Profile); it throws an actionable error
 * naming the file and the problem instead.
 */
export async function loadRegistry(stateDir: string): Promise<Registry> {
  const path = registryPath(stateDir);

  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    if (isErrnoException(err) && err.code === "ENOENT") {
      return { profiles: {} };
    }
    throw new Error(
      `Could not read the Profile registry at '${path}': ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`The Profile registry at '${path}' is not valid JSON. Fix or remove it before continuing.`);
  }

  return validateRegistry(parsed, path);
}

/** Writes the registry to `<stateDir>/registry.json`, creating the state directory if needed. */
export async function saveRegistry(stateDir: string, registry: Registry): Promise<void> {
  await mkdir(stateDir, { recursive: true });
  await writeFile(registryPath(stateDir), `${JSON.stringify(registry, null, 2)}\n`, "utf8");
}

/**
 * Creates a Profile named `alias`: an isolated configuration directory under `stateDir` with the
 * Rig shared into it from `installDir` (ADR-0007) and its settings rendered from the Default
 * install's base (ADR-0002) — including the status-line Alias indicator ticket #10 requires a
 * running Session to show — registered in the registry with no {@link ExpectedIdentity} yet.
 * Checks for a duplicate Alias before touching the filesystem or the registry, so a rejected
 * `add` changes nothing.
 */
export async function addProfile(
  stateDir: string,
  alias: string,
  installDir: string,
): Promise<{ alias: string; configDir: string }> {
  if (alias === DEFAULT_INSTALL_ALIAS) {
    throw new Error(`'${DEFAULT_INSTALL_ALIAS}' is reserved for the Default install and can't be used as an Alias.`);
  }
  if (!isValidAlias(alias)) {
    throw new Error(
      `Alias '${alias}' is invalid: it must not be empty, '.', '..', or contain a path separator.`,
    );
  }

  const registry = await loadRegistry(stateDir);
  if (Object.hasOwn(registry.profiles, alias)) {
    throw new Error(`A Profile named '${alias}' already exists. Choose a different Alias.`);
  }

  const configDir = join(stateDir, "profiles", alias);
  await mkdir(configDir, { recursive: true });
  await shareRig(installDir, configDir);
  await renderSettings({
    baseSettingsPath: join(installDir, SETTINGS_FILE_NAME),
    outputSettingsPath: join(configDir, SETTINGS_FILE_NAME),
  });

  registry.profiles[alias] = { configDir, expectedIdentity: null, drifted: false };
  await saveRegistry(stateDir, registry);

  return { alias, configDir };
}

/**
 * Records `identity` as `alias`'s Expected identity (ADR-0006), leaving every other alias already
 * in the registry untouched — the cross-Profile isolation `ccp login`'s acceptance criteria
 * require. `alias` must already be registered (by `addProfile`, directly or via `ccp login`
 * auto-provisioning it) so its `configDir` has somewhere to come from other than fabricating one.
 *
 * Also clears `drifted`: a freshly recorded Expected identity — whether from `ccp login` or
 * `ccp reconcile` (ticket #8) — is by definition the new baseline, so there is nothing left to
 * have drifted from yet.
 */
export async function recordExpectedIdentity(
  stateDir: string,
  alias: string,
  identity: ExpectedIdentity,
): Promise<void> {
  const registry = await loadRegistry(stateDir);
  const record = registry.profiles[alias];
  if (!record) {
    throw new Error(`No Profile named '${alias}' is registered. Run 'ccp add ${alias}' first.`);
  }

  registry.profiles[alias] = { ...record, expectedIdentity: identity, drifted: false };
  await saveRegistry(stateDir, registry);
}

/**
 * Records whether Binding last observed `alias` in Drift (CONTEXT.md), leaving its `configDir`
 * and `expectedIdentity` untouched. The one writer of {@link ProfileRecord.drifted}, called by
 * `ccp use` (ticket #8) each time it checks a Profile's observed identity against its Expected
 * identity — never by `ccp ls`, which only ever reads this stored flag rather than re-deriving it.
 */
export async function recordDrift(stateDir: string, alias: string, drifted: boolean): Promise<void> {
  const registry = await loadRegistry(stateDir);
  const record = registry.profiles[alias];
  if (!record) {
    throw new Error(`No Profile named '${alias}' is registered. Run 'ccp add ${alias}' first.`);
  }

  registry.profiles[alias] = { ...record, drifted };
  await saveRegistry(stateDir, registry);
}

/**
 * An Alias becomes its Profile's config directory's path segment (`join(stateDir, "profiles",
 * alias)`), so anything a path separator or a `.`/`..` segment could turn into traversal outside
 * `stateDir` is rejected here rather than left to `mkdir` to resolve unpredictably.
 */
function isValidAlias(alias: string): boolean {
  return alias.length > 0 && alias !== "." && alias !== ".." && !alias.includes("/") && !alias.includes("\\");
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateRegistry(parsed: unknown, path: string): Registry {
  if (!isPlainObject(parsed) || !("profiles" in parsed)) {
    throw new Error(
      `The Profile registry at '${path}' is malformed (expected an object with a 'profiles' key). Fix or remove it before continuing.`,
    );
  }

  const profilesRaw = parsed.profiles;
  if (!isPlainObject(profilesRaw)) {
    throw new Error(
      `The Profile registry at '${path}' is malformed ('profiles' must be an object). Fix or remove it before continuing.`,
    );
  }

  const profiles: Record<string, ProfileRecord> = {};
  for (const [alias, value] of Object.entries(profilesRaw)) {
    profiles[alias] = validateProfileRecord(value, alias, path);
  }

  return { profiles };
}

function validateProfileRecord(value: unknown, alias: string, path: string): ProfileRecord {
  if (!isPlainObject(value)) {
    throw new Error(
      `The Profile registry at '${path}' is malformed (entry '${alias}' must be an object). Fix or remove it before continuing.`,
    );
  }

  if (typeof value.configDir !== "string") {
    throw new Error(
      `The Profile registry at '${path}' is malformed (entry '${alias}' is missing 'configDir'). Fix or remove it before continuing.`,
    );
  }

  const expectedIdentity = validateExpectedIdentity(value.expectedIdentity, alias, path);
  const drifted = validateDrifted(value.drifted, alias, path);

  return { configDir: value.configDir, expectedIdentity, drifted };
}

/** Defaults to `false` when absent, so a registry written before ticket #8 added this field still
 * loads instead of being treated as malformed. */
function validateDrifted(value: unknown, alias: string, path: string): boolean {
  if (value === undefined) return false;

  if (typeof value !== "boolean") {
    throw new Error(
      `The Profile registry at '${path}' is malformed (entry '${alias}' has an invalid 'drifted'). Fix or remove it before continuing.`,
    );
  }

  return value;
}

function validateExpectedIdentity(value: unknown, alias: string, path: string): ExpectedIdentity | null {
  if (value === null || value === undefined) return null;

  if (!isPlainObject(value) || typeof value.email !== "string" || typeof value.orgName !== "string") {
    throw new Error(
      `The Profile registry at '${path}' is malformed (entry '${alias}' has an invalid 'expectedIdentity'). Fix or remove it before continuing.`,
    );
  }

  return { email: value.email, orgName: value.orgName };
}
