import { homedir } from "node:os";
import { join } from "node:path";
import { resolveBinding } from "./binding.js";
import { ClaudeCliPort, type AuthStatus, type ClaudePort } from "./claude-port.js";
import { addProfile, DEFAULT_INSTALL_ALIAS, loadRegistry } from "./registry.js";

const USAGE =
  "Usage: ccp <command>\n\nCommands:\n  whoami       Report the bound Profile's identity\n  add <alias>  Create a new Profile\n  ls           List every Profile";

const NOT_LOGGED_IN = "(not logged in)";
const NEVER_LOGGED_IN = "(never logged in)";
const UNKNOWN = "(unknown)";

/** The tool's own state directory: holds the Profile registry and every managed Profile's
 * isolated config directory. */
function defaultStateDir(): string {
  return join(homedir(), ".ccacct");
}

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
  /** Test seam: the tool's own state directory, holding the Profile registry and every managed
   * Profile's isolated config directory. Defaults to `~/.ccacct`. */
  stateDir?: string;
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
  const stateDir = options.stateDir ?? defaultStateDir();

  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") {
    stdout(USAGE);
    return 0;
  }

  switch (argv[0]) {
    case "whoami":
      return runWhoami({ env, stdout, stderr, claudePort });
    case "add":
      return runAdd({ alias: argv[1], stateDir, stdout, stderr });
    case "ls":
      return runLs({ stateDir, stdout, stderr, claudePort });
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
    return reportError(deps.stderr, err);
  }

  deps.stdout(formatWhoami(alias, status));
  return 0;
}

/** Prints an error's message to `stderr` and resolves the standard failure exit code — the one
 * shape every command's fallible step reports through. */
function reportError(stderr: (line: string) => void, err: unknown): number {
  stderr(err instanceof Error ? err.message : String(err));
  return 1;
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

/**
 * `ccp add <alias>`: creates a Profile with its own isolated config directory under the tool's
 * state directory and registers its Alias. Alias validity — uniqueness, and the reserved
 * {@link DEFAULT_INSTALL_ALIAS} sentinel — is enforced by {@link addProfile} itself, so a
 * rejection here always means the registry was left exactly as it was.
 */
async function runAdd(deps: {
  alias: string | undefined;
  stateDir: string;
  stdout: (line: string) => void;
  stderr: (line: string) => void;
}): Promise<number> {
  const { alias } = deps;
  if (!alias) {
    deps.stderr("Usage: ccp add <alias>");
    return 1;
  }

  try {
    const result = await addProfile(deps.stateDir, alias);
    deps.stdout(`Created Profile '${result.alias}' at ${result.configDir}`);
    return 0;
  } catch (err) {
    return reportError(deps.stderr, err);
  }
}

/**
 * `ccp ls`: lists every managed Profile with its recorded Expected identity, or an explicit
 * never-logged-in state (CONTEXT.md's Login hasn't happened yet for any Profile this tool can
 * create), followed by the Default install's row. Per ADR-0003, that row is never migrated or
 * mutated and must show its real, live identity rather than a blank — the whole reason `ccp ls`
 * exists is to stop the expensive account from being used by accident.
 */
async function runLs(deps: {
  stateDir: string;
  stdout: (line: string) => void;
  stderr: (line: string) => void;
  claudePort: ClaudePort;
}): Promise<number> {
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
      return `${alias}: ${identity}`;
    });

  let defaultStatus: AuthStatus;
  try {
    defaultStatus = await deps.claudePort.authStatus();
  } catch (err) {
    return reportError(deps.stderr, err);
  }

  const defaultIdentity = !defaultStatus.loggedIn
    ? NOT_LOGGED_IN
    : formatIdentity({ email: defaultStatus.email ?? UNKNOWN, orgName: defaultStatus.orgName ?? UNKNOWN });
  lines.push(`${DEFAULT_INSTALL_ALIAS}: ${defaultIdentity} [unmanaged]`);

  deps.stdout(lines.join("\n"));
  return 0;
}

/** Renders an (Account, Organization) pair the way both a recorded Expected identity and a live
 * {@link AuthStatus} are shown in `ccp ls` — the one shape both call sites share. */
function formatIdentity(identity: { email: string; orgName: string }): string {
  return `${identity.email} (${identity.orgName})`;
}
