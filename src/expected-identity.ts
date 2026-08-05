import { readFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * The (Account, Organization) a Profile is recorded as expecting to resolve to — see
 * CONTEXT.md's **Expected identity**. Never an authority, so both fields stay optional even
 * once recorded: a Profile can expect an Account without caring which Organization, or vice
 * versa.
 */
export interface ExpectedIdentity {
  email?: string;
  orgName?: string;
}

/**
 * Where a Profile's Expected identity lives, relative to its own config directory — see
 * ADR-0006. `ccp login` (#4) owns writing this file; this module only reads it.
 */
const EXPECTED_IDENTITY_PATH = [".ccp", "expected-identity.json"];

/**
 * Reads a Profile's recorded Expected identity, or `undefined` if none has ever been recorded
 * (no `ccp login` yet) or the file can't be trusted. Never throws: per CONTEXT.md, an Expected
 * identity is an expectation, not an authority, so a bad read degrades to "nothing expected"
 * rather than blocking Binding.
 */
export async function readExpectedIdentity(configDir: string): Promise<ExpectedIdentity | undefined> {
  let raw: string;
  try {
    raw = await readFile(join(configDir, ...EXPECTED_IDENTITY_PATH), "utf8");
  } catch {
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return undefined;
  }

  const record = parsed as Record<string, unknown>;
  return {
    email: typeof record.email === "string" ? record.email : undefined,
    orgName: typeof record.orgName === "string" ? record.orgName : undefined,
  };
}
