import { describe, expect, it } from "vitest";
import { withProfileStatusLine } from "../src/status-line.js";

describe("withProfileStatusLine", () => {
  it("installs an Alias-only statusLine when none was configured", () => {
    const result = withProfileStatusLine({ model: "sonnet" });

    expect(result.model).toBe("sonnet");
    const statusLine = result.statusLine as { type: string; command: string };
    expect(statusLine.type).toBe("command");
    expect(statusLine.command).toMatch(/CLAUDE_CONFIG_DIR/);
  });

  it("falls back to the Default install's Alias when CLAUDE_CONFIG_DIR is unset", () => {
    const result = withProfileStatusLine({});
    const statusLine = result.statusLine as { command: string };
    expect(statusLine.command).toMatch(/\(default\)/);
  });

  it("chains a pre-existing statusLine command rather than discarding it", () => {
    const result = withProfileStatusLine({ statusLine: { type: "command", command: "~/.claude/my-statusline.sh" } });

    const statusLine = result.statusLine as { command: string };
    expect(statusLine.command).toMatch(/CLAUDE_CONFIG_DIR/);
    expect(statusLine.command).toContain("~/.claude/my-statusline.sh");
    // The original command must run after the Alias segment, not before it.
    expect(statusLine.command.indexOf("CLAUDE_CONFIG_DIR")).toBeLessThan(
      statusLine.command.indexOf("~/.claude/my-statusline.sh"),
    );
  });

  it("leaves every other key untouched", () => {
    const result = withProfileStatusLine({ model: "sonnet", hooks: { onStart: ["a"] } });
    expect(result.model).toBe("sonnet");
    expect(result.hooks).toEqual({ onStart: ["a"] });
  });

  it("leaves an unrecognized statusLine shape alone rather than guessing at how to extend it", () => {
    const original = { statusLine: { type: "unknown-shape", foo: "bar" } };
    expect(withProfileStatusLine(original)).toEqual(original);
  });
});
