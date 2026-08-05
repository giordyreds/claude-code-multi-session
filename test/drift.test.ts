import { describe, expect, it } from "vitest";
import { isDrifted } from "../src/drift.js";

describe("isDrifted", () => {
  it("is false when no Expected identity has ever been recorded", () => {
    expect(isDrifted(null, { loggedIn: true, email: "dev@example.com", orgName: "Acme Corp" })).toBe(false);
  });

  it("is false when the Profile is not logged in, even with an Expected identity on record", () => {
    expect(isDrifted({ email: "dev@example.com", orgName: "Acme Corp" }, { loggedIn: false })).toBe(false);
  });

  it("is false when the observed identity matches the Expected identity exactly", () => {
    const identity = { email: "dev@example.com", orgName: "Acme Corp" };
    expect(isDrifted(identity, { loggedIn: true, ...identity })).toBe(false);
  });

  it("is true when the observed Account differs", () => {
    expect(
      isDrifted(
        { email: "dev@example.com", orgName: "Acme Corp" },
        { loggedIn: true, email: "someone-else@example.com", orgName: "Acme Corp" },
      ),
    ).toBe(true);
  });

  it("is true when the observed Organization differs", () => {
    expect(
      isDrifted(
        { email: "dev@example.com", orgName: "Acme Corp" },
        { loggedIn: true, email: "dev@example.com", orgName: "A Different Org" },
      ),
    ).toBe(true);
  });

  it("is false when logged in but claude omits email/orgName — nothing trustworthy to compare", () => {
    expect(isDrifted({ email: "dev@example.com", orgName: "Acme Corp" }, { loggedIn: true })).toBe(false);
  });
});
