import type { SettingsValue } from "./settings.js";

/** Mirrors registry.ts's `DEFAULT_INSTALL_ALIAS` — an unbound Session must show this explicit
 * marker rather than nothing, so a missing indicator is never ambiguous with being unbound
 * (ticket #10's acceptance criteria, ADR-0003). Not imported directly: `registry.ts` already
 * imports `settings.ts` (to render each Profile's settings file), which imports this module, so
 * importing `registry.ts` back from here would close that into a cycle. Kept in sync by hand. */
const DEFAULT_INSTALL_ALIAS = "(default)";

/** A settings file's `statusLine` value, per Claude Code's own schema — the one shape this
 * module ever wraps or extends. */
interface CommandStatusLine {
  type: "command";
  command: string;
}

/**
 * Extends `settings.statusLine` with the active Profile's Alias, so a running Session always
 * shows which Profile it's operating under (ticket #10) — without ever discarding whatever
 * statusLine the base settings (or a per-Profile override) already configured.
 *
 * The Alias segment is resolved by a shell snippet, not baked in at render time: Claude Code
 * inherits `CLAUDE_CONFIG_DIR` from the shell it was launched from (the same variable Binding
 * itself sets — ADR-0005), so the snippet reads it fresh each time the status line renders,
 * exactly as `ccp.sh`'s prompt segment does. This is what makes one rendered file correct for
 * every Profile, and immune to becoming stale if a Profile's config directory ever moved.
 *
 * A pre-existing `statusLine.command` is chained after the Alias segment, in the same shell
 * invocation, rather than piped or captured — Claude Code decides how to invoke `command` and
 * what it feeds it on stdin, and this project has no documented reason to assume beyond "a shell
 * command line" (ADR-0005's stance on `claude`'s undocumented surfaces applies equally here).
 * Chaining with `;` preserves that stdin for the original command untouched, since nothing in
 * the Alias segment reads it.
 *
 * A `statusLine` present but not shaped like {@link CommandStatusLine} is left completely alone:
 * ticket #10's acceptance criteria call for extending the user's configuration, never replacing
 * it, and guessing at an unrecognized shape would risk exactly that.
 */
export function withProfileStatusLine(settings: SettingsValue): SettingsValue {
  const existing = settings.statusLine;

  if (existing !== undefined && !isCommandStatusLine(existing)) {
    return settings;
  }

  const command = existing === undefined ? aliasSegmentShell() : `${aliasSegmentShell()}; ${existing.command}`;

  return { ...settings, statusLine: { type: "command", command } satisfies CommandStatusLine };
}

/** The shell snippet a rendered `statusLine.command` always starts with: resolves the active
 * Alias the same way `ccp.sh`'s prompt segment does (`CLAUDE_CONFIG_DIR`'s basename, or the
 * Default install's Alias when unset) and prints it as a `[alias] ` prefix. */
function aliasSegmentShell(): string {
  return (
    'alias_name=$(basename "${CLAUDE_CONFIG_DIR:-}"); ' +
    `[ -z "$alias_name" ] && alias_name="${DEFAULT_INSTALL_ALIAS}"; ` +
    'printf "[%s] " "$alias_name"'
  );
}

function isCommandStatusLine(value: unknown): value is CommandStatusLine {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as Record<string, unknown>).type === "command" &&
    typeof (value as Record<string, unknown>).command === "string"
  );
}
