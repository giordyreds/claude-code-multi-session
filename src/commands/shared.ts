import { reportError } from "../fs-utils.js";
import { loadRegistry, type ProfileRecord } from "../registry.js";

/**
 * Command-layer helpers used by more than one `commands/*.ts` module — a home that exists
 * specifically so a helper with no single domain owner doesn't get assigned a false one (ADR-0015).
 * Every helper here is glue between {@link CliDeps} and the domain layer, not pure domain logic
 * itself; a pure, layer-appropriate helper belongs one layer down instead (see `identity.ts`'s
 * `formatLiveIdentity` for that shape).
 */

/**
 * Loads the registry and looks up `alias`'s entry, reporting an actionable error to stderr — and
 * resolving `undefined` — when the registry can't be read or `alias` isn't registered. Used by
 * `commands/shell.ts`'s `ccp run`, `commands/identity.ts`'s `ccp reconcile`, and
 * `commands/profile.ts`'s `ccp rm` — three of the four command modules, no single domain owner
 * among them. `commands/shell.ts`'s `ccp use` inlines the same lookup itself rather than calling
 * this, since it already has the registry in hand from resolving a picked Alias.
 */
export async function resolveKnownProfile(
  deps: { stateDir: string; stderr: (line: string) => void },
  alias: string,
): Promise<ProfileRecord | undefined> {
  let registry;
  try {
    registry = await loadRegistry(deps.stateDir);
  } catch (err) {
    reportError(deps.stderr, err);
    return undefined;
  }

  const record = registry.profiles[alias];
  if (!record) {
    deps.stderr(`Unknown Alias '${alias}': no Profile named '${alias}' is registered. Run 'ccp add ${alias}' first.`);
    return undefined;
  }

  return record;
}
