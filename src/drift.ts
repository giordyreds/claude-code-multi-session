import type { AuthStatus } from "./claude-port.js";
import { sameIdentity, type Identity } from "./identity.js";

/**
 * Whether a Profile's observed identity (`status`, fresh from {@link ClaudePort.authStatus})
 * diverges from its Expected identity — see CONTEXT.md's **Drift**. Only meaningful when both
 * sides of the comparison actually exist: a Profile with no recorded Expected identity, or one
 * that isn't currently logged in, has nothing to have drifted *from* or *to*, so those report
 * `false` rather than a false positive.
 */
export function isDrifted(expected: Identity | null, status: AuthStatus): boolean {
  if (!expected || !status.loggedIn || status.email === undefined || status.orgName === undefined) {
    return false;
  }

  return !sameIdentity(expected, { email: status.email, orgName: status.orgName });
}
