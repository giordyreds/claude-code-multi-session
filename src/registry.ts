import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** The (Account, Organization) a Profile is recorded as resolving to — see CONTEXT.md's
 * **Expected identity**. `null` until something (a future Login/Reconciliation command) records
 * one; that is the ordinary state for every Profile this ticket can create. */
export interface ExpectedIdentity {
  email: string;
  orgName: string;
}

/** A managed Profile's registry entry. Alias is the key it's stored under, not a field here —
 * same "no separately stored field" shape ADR-0005 already committed to for the bare Alias. */
export interface ProfileRecord {
  configDir: string;
  expectedIdentity: ExpectedIdentity | null;
}

/** The Profile registry — see ADR-0005's deferred registry file, now created by `ccp add`. */
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
 * Creates a Profile named `alias`: an isolated, empty configuration directory under `stateDir`,
 * registered in the registry with no {@link ExpectedIdentity} yet. Checks for a duplicate Alias
 * before touching the filesystem or the registry, so a rejected `add` changes nothing.
 */
export async function addProfile(stateDir: string, alias: string): Promise<{ alias: string; configDir: string }> {
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

  registry.profiles[alias] = { configDir, expectedIdentity: null };
  await saveRegistry(stateDir, registry);

  return { alias, configDir };
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

  return { configDir: value.configDir, expectedIdentity };
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

function isErrnoException(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && "code" in err;
}
