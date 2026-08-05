import { resolveBinding } from "./binding.js";
import { ClaudeCliPort, type AuthStatus, type ClaudePort } from "./claude-port.js";

const USAGE = "Usage: ccp <command>\n\nCommands:\n  whoami   Report the bound Profile's identity";

/** The Alias {@link resolveBinding} reports as `"(default)"` for an unbound shell isn't a real Alias — it's this sentinel, matching CONTEXT.md's Default install language. */
const DEFAULT_INSTALL_ALIAS = "(default)";

const NOT_LOGGED_IN = "(not logged in)";
const UNKNOWN = "(unknown)";

export interface RunCliOptions {
  /** The shell environment to resolve Binding from. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
  /**
   * Test seam: replaces every invocation of the real `claude` executable (see ADR-0005) so
   * `whoami` — and every future identity-resolving command — is testable without spawning it.
   * Defaults to a real {@link ClaudeCliPort}.
   */
  claudePort?: ClaudePort;
}

/**
 * Runs the `ccp` CLI for one invocation and resolves its process exit code. The single seam
 * every subcommand dispatches through — tests drive the whole tool through this one function.
 */
export async function runCli(argv: string[], options: RunCliOptions = {}): Promise<number> {
  const env = options.env ?? process.env;
  const stdout = options.stdout ?? ((line: string) => console.log(line));
  const stderr = options.stderr ?? ((line: string) => console.error(line));
  const claudePort = options.claudePort ?? new ClaudeCliPort();

  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") {
    stdout(USAGE);
    return 0;
  }

  switch (argv[0]) {
    case "whoami":
      return runWhoami({ env, stdout, stderr, claudePort });
    default:
      stderr(`Unknown command '${argv[0]}'. ${USAGE}`);
      return 1;
  }
}

/**
 * `ccp whoami`: reports the bound Profile's Alias and the Account/Organization it resolves to.
 * An unbound shell reports the Default install's identity under the `(default)` Alias — never a
 * blank — since under ADR-0003 unbound means the Default install, not "no identity".
 */
async function runWhoami(deps: {
  env: NodeJS.ProcessEnv;
  stdout: (line: string) => void;
  stderr: (line: string) => void;
  claudePort: ClaudePort;
}): Promise<number> {
  const binding = resolveBinding(deps.env);
  const alias = binding.bound ? binding.alias : DEFAULT_INSTALL_ALIAS;
  const configDir = binding.bound ? binding.configDir : undefined;

  let status: AuthStatus;
  try {
    status = await deps.claudePort.authStatus(configDir);
  } catch (err) {
    deps.stderr(err instanceof Error ? err.message : String(err));
    return 1;
  }

  deps.stdout(formatWhoami(alias, status));
  return 0;
}

/**
 * Renders `whoami`'s report. Account/Organization fall back to an explicit `(not logged in)` —
 * a Profile can be Bound but not logged in (CONTEXT.md's Login) — rather than ever printing a
 * blank. A logged-in status missing its email/orgName (permitted by {@link AuthStatus}'s shape,
 * even though the real `claude auth status --json` always supplies both — ADR-0005) falls back
 * to `(unknown)` instead: reusing `(not logged in)` there would be an outright false statement,
 * not an honest fallback.
 */
function formatWhoami(alias: string, status: AuthStatus): string {
  const account = !status.loggedIn ? NOT_LOGGED_IN : status.email ?? UNKNOWN;
  const organization = !status.loggedIn ? NOT_LOGGED_IN : status.orgName ?? UNKNOWN;
  return [`Alias:        ${alias}`, `Account:      ${account}`, `Organization: ${organization}`].join("\n");
}
