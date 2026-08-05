import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Exercises the real prompt indicator `shell/ccp.sh` installs (ticket #10) against a real `bash`
 * process. Only `CLAUDE_CONFIG_DIR` is faked (ADR-0005's Binding mechanism) — the prompt segment
 * itself is plain shell, so there's no `ccp` binary to build or stand in for here, unlike
 * shell-integration.test.ts's zsh suite.
 *
 * PS1 is never actually *drawn* outside an interactive prompt loop, so each case renders it the
 * same way a real prompt draw would: `eval` a `printf` of the (still-quoted) `$PS1` value, which
 * expands whatever command substitution it now contains exactly as bash would at the next prompt.
 */
const ccpShPath = fileURLToPath(new URL("../shell/ccp.sh", import.meta.url));

function renderPrompt(script: string, env: NodeJS.ProcessEnv = {}): string {
  const result = spawnSync("bash", ["--noprofile", "--norc", "-c", script], {
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "", ...env },
  });
  if (result.status !== 0) {
    throw new Error(`script failed (status ${result.status}): ${result.stderr}`);
  }
  return result.stdout;
}

describe("ccp.sh prompt indicator", () => {
  it("shows '(default)' for an unbound shell, extending rather than replacing the existing PS1", () => {
    const stdout = renderPrompt(`
      PS1="myprompt$ "
      source ${JSON.stringify(ccpShPath)}
      eval "printf '%s' \\"$PS1\\""
    `);

    expect(stdout).toContain("[(default)] ");
    expect(stdout).toContain("myprompt$ ");
  });

  it("shows the bound Alias once CLAUDE_CONFIG_DIR is set", () => {
    const stdout = renderPrompt(
      `
      PS1="myprompt$ "
      source ${JSON.stringify(ccpShPath)}
      eval "printf '%s' \\"$PS1\\""
    `,
      { CLAUDE_CONFIG_DIR: "/tmp/ccacct/profiles/work" },
    );

    expect(stdout).toContain("[work] ");
    expect(stdout).not.toContain("(default)");
  });

  it("updates immediately when Binding changes CLAUDE_CONFIG_DIR, without sourcing a new shell", () => {
    const stdout = renderPrompt(`
      PS1="myprompt$ "
      source ${JSON.stringify(ccpShPath)}
      before=$(eval "printf '%s' \\"$PS1\\"")
      export CLAUDE_CONFIG_DIR=/tmp/ccacct/profiles/personal
      after=$(eval "printf '%s' \\"$PS1\\"")
      printf 'BEFORE:%s\\nAFTER:%s\\n' "$before" "$after"
    `);

    expect(stdout).toContain("BEFORE:[(default)] myprompt$");
    expect(stdout).toContain("AFTER:[personal] myprompt$");
  });

  it("never stacks a second copy of the segment when sourced twice", () => {
    const stdout = renderPrompt(`
      PS1="myprompt$ "
      source ${JSON.stringify(ccpShPath)}
      source ${JSON.stringify(ccpShPath)}
      eval "printf '%s' \\"$PS1\\""
    `);

    expect(stdout.match(/\(default\)/g)?.length).toBe(1);
  });
});
