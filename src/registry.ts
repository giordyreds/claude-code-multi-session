import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** The (Account, Organization) pair recorded for a Profile — see CONTEXT.md's Expected identity. */
export interface ExpectedIdentity {
  email: string;
  orgName: string;
}

/** The registry file's on-disk shape — see ADR-0006. */
export interface RegistryData {
  profiles: Record<string, { expectedIdentity: ExpectedIdentity | null }>;
}

const REGISTRY_FILENAME = "registry.json";

function emptyRegistry(): RegistryData {
  return { profiles: {} };
}

/**
 * Reads the registry file rooted at `stateDir`. A missing file is not malformed — it's a state
 * directory nothing has ever written to yet — and reads back as an empty registry. A file that
 * exists but is unparseable or the wrong shape throws an actionable error instead of silently
 * resetting it, since a Profile's recorded Expected identity is the one thing this tool cannot
 * afford to lose without saying so.
 */
export async function readRegistry(stateDir: string): Promise<RegistryData> {
  const path = join(stateDir, REGISTRY_FILENAME);

  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    if (isNotFound(err)) return emptyRegistry();
    throw err;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${path} is not valid JSON. Fix or remove it before continuing.`);
  }

  if (!isRegistryShaped(parsed)) {
    throw new Error(`${path} is malformed (expected a "profiles" object). Fix or remove it before continuing.`);
  }

  return parsed;
}

function isRegistryShaped(value: unknown): value is RegistryData {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const profiles = (value as Record<string, unknown>).profiles;
  return typeof profiles === "object" && profiles !== null && !Array.isArray(profiles);
}

async function writeRegistry(stateDir: string, registry: RegistryData): Promise<void> {
  await mkdir(stateDir, { recursive: true });
  await writeFile(join(stateDir, REGISTRY_FILENAME), `${JSON.stringify(registry, null, 2)}\n`, "utf8");
}

/**
 * Records `identity` as `alias`'s expected identity, leaving every other alias already in the
 * registry untouched — the cross-Profile isolation `ccp login`'s acceptance criteria require.
 */
export async function recordExpectedIdentity(stateDir: string, alias: string, identity: ExpectedIdentity): Promise<void> {
  const registry = await readRegistry(stateDir);
  registry.profiles[alias] = { expectedIdentity: identity };
  await writeRegistry(stateDir, registry);
}

/** The expected identity recorded for `alias`, or `null` if it has none (including if unregistered). */
export async function expectedIdentityFor(stateDir: string, alias: string): Promise<ExpectedIdentity | null> {
  const registry = await readRegistry(stateDir);
  return registry.profiles[alias]?.expectedIdentity ?? null;
}

/**
 * The config directory for `alias` under `stateDir` — ADR-0006's convention that a Profile's
 * directory is computed from its Alias, never stored or looked up. Rejects any alias that would
 * resolve outside `stateDir` (a path separator, or a bare `.`/`..` segment): every caller needs
 * "scoped to that Profile only" to actually hold, not just to hold for well-behaved aliases.
 */
export function configDirFor(stateDir: string, alias: string): string {
  if (alias === "" || alias === "." || alias === ".." || /[/\\]/.test(alias)) {
    throw new Error(`'${alias}' is not a valid Profile alias.`);
  }
  return join(stateDir, alias);
}

function isNotFound(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && (err as { code: unknown }).code === "ENOENT";
}
