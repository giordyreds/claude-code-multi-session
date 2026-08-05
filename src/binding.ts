import { basename, resolve as resolvePath } from "node:path";

/**
 * Which Profile (if any) the current shell is bound to — see CONTEXT.md's **Binding** and
 * ADR-0005. A shell property: read from the env passed in, never from ambient global state, so
 * callers control exactly whose environment is being asked about.
 */
export type Binding = { bound: false } | { bound: true; alias: string; configDir: string };

/**
 * Resolves {@link Binding} from `CLAUDE_CONFIG_DIR`. Unset (or empty) means unbound. Per
 * ADR-0005, a bound Profile's Alias is its config directory's basename — there is no separate
 * registry to look it up in.
 */
export function resolveBinding(env: NodeJS.ProcessEnv): Binding {
  const raw = env.CLAUDE_CONFIG_DIR;
  if (!raw) return { bound: false };

  const configDir = resolvePath(raw);
  return { bound: true, alias: basename(configDir), configDir };
}
