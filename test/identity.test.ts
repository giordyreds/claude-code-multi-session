import { describe, expect, it } from "vitest";
import { compareToExpected, formatIdentity, identityKey, sameIdentity } from "../src/identity.js";

describe("formatIdentity", () => {
  it("renders as 'email (orgName)'", () => {
    expect(formatIdentity({ email: "dev@example.com", orgName: "Acme Corp" })).toBe("dev@example.com (Acme Corp)");
  });
});

describe("identityKey", () => {
  it("is equal for two Identity values naming the same pair", () => {
    const a = { email: "dev@example.com", orgName: "Acme Corp" };
    const b = { email: "dev@example.com", orgName: "Acme Corp" };
    expect(identityKey(a)).toBe(identityKey(b));
  });

  it("differs when the Account differs", () => {
    expect(identityKey({ email: "dev@example.com", orgName: "Acme Corp" })).not.toBe(
      identityKey({ email: "someone-else@example.com", orgName: "Acme Corp" }),
    );
  });

  it("differs when the Organization differs", () => {
    expect(identityKey({ email: "dev@example.com", orgName: "Acme Corp" })).not.toBe(
      identityKey({ email: "dev@example.com", orgName: "A Different Org" }),
    );
  });
});

describe("sameIdentity", () => {
  it("is true for two Identity values naming the same pair", () => {
    const identity = { email: "dev@example.com", orgName: "Acme Corp" };
    expect(sameIdentity(identity, { ...identity })).toBe(true);
  });

  it("is false when either half differs", () => {
    expect(sameIdentity({ email: "dev@example.com", orgName: "Acme Corp" }, { email: "dev@example.com", orgName: "Other" })).toBe(
      false,
    );
  });
});

describe("compareToExpected", () => {
  it("is not comparable when no Expected identity has ever been recorded", () => {
    expect(compareToExpected(null, { email: "dev@example.com", orgName: "Acme Corp" })).toEqual({ comparable: false });
  });

  it("is not comparable when there is no Observed identity, even with an Expected identity on record", () => {
    expect(compareToExpected({ email: "dev@example.com", orgName: "Acme Corp" }, null)).toEqual({ comparable: false });
  });

  it("is comparable and not drifted when the Observed identity matches the Expected identity exactly", () => {
    const identity = { email: "dev@example.com", orgName: "Acme Corp" };
    expect(compareToExpected(identity, { ...identity })).toEqual({ comparable: true, drifted: false });
  });

  it("is comparable and drifted when the observed Account differs", () => {
    expect(
      compareToExpected(
        { email: "dev@example.com", orgName: "Acme Corp" },
        { email: "someone-else@example.com", orgName: "Acme Corp" },
      ),
    ).toEqual({ comparable: true, drifted: true });
  });

  it("is comparable and drifted when the observed Organization differs", () => {
    expect(
      compareToExpected(
        { email: "dev@example.com", orgName: "Acme Corp" },
        { email: "dev@example.com", orgName: "A Different Org" },
      ),
    ).toEqual({ comparable: true, drifted: true });
  });

  it("is not comparable when logged in but claude omits email/orgName — nothing trustworthy to compare", () => {
    // `observed` is `null` here, not a half-filled object — the shape `claude-port.ts`'s
    // `toAuthStatus` narrows an incomplete logged-in report into (issue #48).
    expect(compareToExpected({ email: "dev@example.com", orgName: "Acme Corp" }, null)).toEqual({ comparable: false });
  });
});
