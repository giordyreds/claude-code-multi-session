import { resolveBinding } from "./binding.js";
import { ClaudeCliPort, type AuthStatus, type ClaudePort } from "./claude-port.js";
import { readExpectedIdentity, type ExpectedIdentity } from "./expected-identity.js";
import { profileExists, resolveProfileDir } from "./profile.js";

const USAGE =
  "Usage: ccp <command>\n\nCommands:\n  whoami        Report the bound Profile's identity\n  use <alias>   Bind the current shell to a Profile (via the `ccp` shell function)";

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

/** Every subcommand's resolved dependencies, after {@link runCli} has applied defaults. */
interface CliDeps {
  env: NodeJS.ProcessEnv;
  stdout: (line: string) => void;
  stderr: (line: string) => void;
  claudePort: ClaudePort;
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
    case "use":
      return runUse(argv[1], { env, stdout, stderr, claudePort });
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
async function runWhoami(deps: CliDeps): Promise<number> {
  const binding = resolveBinding(deps.env);
  const alias = binding.bound ? binding.alias : DEFAULT_INSTALL_ALIAS;
  const configDir = binding.bound ? binding.configDir : undefined;

  const status = await resolveAuthStatus(deps, configDir);
  if (!status) return 1;

  deps.stdout(formatWhoami(alias, status));
  return 0;
}

/**
 * Runs {@link ClaudePort.authStatus} and reports a failure to stderr, returning `undefined` so
 * callers can bail out with exit code 1 — the one piece every identity-resolving subcommand
 * shares.
 */
async function resolveAuthStatus(deps: CliDeps, configDir: string | undefined): Promise<AuthStatus | undefined> {
  try {
    return await deps.claudePort.authStatus(configDir);
  } catch (err) {
    deps.stderr(err instanceof Error ? err.message : String(err));
    return undefined;
  }
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
 * `ccp use <alias>`: prints the `export CLAUDE_CONFIG_DIR=...` line the `ccp` shell function
 * (ADR-0004) evaluates to bind the calling shell to a Profile. Per ADR-0004, **only** that
 * export statement ever reaches stdout — every diagnostic below goes to stderr, and binding
 * still succeeds (still prints the export) for every diagnostic except an unknown Alias or a
 * hard {@link ClaudePort} failure, neither of which leaves a Profile to bind to.
 */
async function runUse(alias: string | undefined, deps: CliDeps): Promise<number> {
  if (!alias) {
    deps.stderr(`Usage: ccp use <alias>`);
    return 1;
  }

  const configDir = resolveProfileDir(alias, deps.env);
  if (!(await profileExists(configDir))) {
    // Per ADR-0006 there is no registry to be "registered" in — an Alias is known purely by
    // whether its directory exists, so the message must say that, not imply a lookup that
    // doesn't exist.
    deps.stderr(`Unknown Alias '${alias}': no Profile directory exists at ${configDir}.`);
    return 1;
  }

  const status = await resolveAuthStatus(deps, configDir);
  if (!status) return 1;

  if (!status.loggedIn) {
    deps.stderr(`Profile '${alias}' is not logged in.`);
  } else {
    const expected = await readExpectedIdentity(configDir);
    if (expected && hasDrifted(expected, status)) {
      deps.stderr(`Profile '${alias}' has drifted: expected ${describeIdentity(expected)}, observed ${describeIdentity(status)}.`);
    }
  }

  deps.stdout(`export CLAUDE_CONFIG_DIR=${shellQuote(configDir)}`);
  return 0;
}

/** CONTEXT.md's **Drift**: the observed identity no longer matches what was expected. An unset field in `expected` was never recorded, so it can never itself be the cause of Drift. */
function hasDrifted(expected: ExpectedIdentity, observed: AuthStatus): boolean {
  return (
    (expected.email !== undefined && expected.email !== observed.email) ||
    (expected.orgName !== undefined && expected.orgName !== observed.orgName)
  );
}

function describeIdentity(identity: ExpectedIdentity): string {
  return `${identity.email ?? UNKNOWN} / ${identity.orgName ?? UNKNOWN}`;
}

/** Single-quotes a value for safe `sh`/`zsh` evaluation — the only shape of output ADR-0004 permits on stdout. */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
