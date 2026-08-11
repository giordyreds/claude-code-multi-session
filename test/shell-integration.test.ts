import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

/**
 * Exercises the real `shell/ccp.sh` function against the real, built CLI (`dist/bin.js`) inside
 * an actual `zsh` process — the one acceptance criterion (see ticket #5) that a fake port can't
 * stand in for: ADR-0004 requires that *evaluating the CLI's stdout* is what binds a shell, and
 * that only ever happens correctly if stdout carries nothing but the export line. A fake
 * `claude` executable stands in for the real one (ADR-0005: this project never spawns it in
 * tests), driven by env vars this test controls per case.
 *
 * `CCP_HOME` points the real CLI's registry (ADR-0006) at a temp directory rather than a real
 * `$HOME` (ADR-0007's amendment). Aliases are registered the same way a real user would, via
 * `ccp add` against the real binary, rather than by hand-writing `registry.json` — this is the
 * one test that can afford to exercise the full `add` → `use` path end to end.
 */
const repoRoot = fileURLToPath(new URL("..", import.meta.url));

const zshAvailable = spawnSync("zsh", ["--version"]).error === undefined;

describe.skipIf(!zshAvailable)("ccp shell function (zsh integration)", () => {
  let binDir: string;
  let profilesRoot: string;

  beforeAll(() => {
    execFileSync("npm", ["run", "build"], { cwd: repoRoot, stdio: "ignore" });
  });

  beforeEach(async () => {
    binDir = await mkdtemp(join(tmpdir(), "ccp-shell-bin-"));
    profilesRoot = await mkdtemp(join(tmpdir(), "ccp-shell-profiles-"));

    // A fake `claude` on PATH — never the real binary (see ADR-0005). Controlled per-test via
    // $FAKE_CLAUDE_RESPONSE; when that's empty, it derives a response from $CLAUDE_CONFIG_DIR's
    // basename instead, so two differently-bound (sub)shells each get their own distinct identity.
    await writeFile(
      join(binDir, "claude"),
      [
        "#!/bin/sh",
        'if [ -n "$FAKE_CLAUDE_RESPONSE" ]; then',
        '  printf "%s" "$FAKE_CLAUDE_RESPONSE"',
        "else",
        '  alias_name="$(basename "$CLAUDE_CONFIG_DIR")"',
        '  printf \'{"loggedIn":true,"email":"%s@example.com","orgName":"%s Org"}\' "$alias_name" "$alias_name"',
        "fi",
        "exit 0",
        "",
      ].join("\n"),
      { mode: 0o755 },
    );

    // A shim so `command ccp` on PATH reaches the real, built CLI. `import()` (not top-level
    // `await`) so this plain file — no package.json of its own to declare `"type": "module"` —
    // runs the same whether Node treats it as CommonJS or a module.
    await writeFile(
      join(binDir, "ccp"),
      `#!/usr/bin/env node\nimport(${JSON.stringify(join(repoRoot, "dist", "bin.js"))});\n`,
      { mode: 0o755 },
    );
  });

  afterEach(async () => {
    await rm(binDir, { recursive: true, force: true });
    await rm(profilesRoot, { recursive: true, force: true });
  });

  function runInZsh(script: string, fakeClaudeResponse: string): { stdout: string; stderr: string; status: number | null } {
    const result = spawnSync("zsh", ["-f", "-c", script], {
      encoding: "utf8",
      env: {
        PATH: `${binDir}:${process.env.PATH}`,
        CCP_HOME: profilesRoot,
        FAKE_CLAUDE_RESPONSE: fakeClaudeResponse,
      },
    });
    return { stdout: result.stdout, stderr: result.stderr, status: result.status };
  }

  it("binds CLAUDE_CONFIG_DIR in the parent shell, and leaves it usable afterwards, for a known logged-in Profile", () => {
    const { stdout, stderr, status } = runInZsh(
      `source ${JSON.stringify(join(repoRoot, "shell", "ccp.sh"))}
       ccp add work >/dev/null
       ccp use work
       echo "STATUS:$?"
       echo "CONFIG_DIR:${"$"}{CLAUDE_CONFIG_DIR:-<unset>}"
       echo STILL_ALIVE`,
      JSON.stringify({ loggedIn: true, email: "work@example.com", orgName: "Work Org" }),
    );

    expect(status).toBe(0);
    expect(stderr).toBe("");
    expect(stdout).toContain("STATUS:0");
    expect(stdout).toContain(`CONFIG_DIR:${join(profilesRoot, "profiles", "work")}`);
    expect(stdout).toContain("STILL_ALIVE");
  });

  it("still binds, with the logged-out warning appearing on stderr rather than being evaluated", () => {
    const { stdout, stderr, status } = runInZsh(
      `source ${JSON.stringify(join(repoRoot, "shell", "ccp.sh"))}
       ccp add work >/dev/null
       ccp use work
       echo "STATUS:$?"
       echo "CONFIG_DIR:${"$"}{CLAUDE_CONFIG_DIR:-<unset>}"`,
      JSON.stringify({ loggedIn: false }),
    );

    expect(status).toBe(0);
    expect(stdout).toContain("STATUS:0");
    expect(stdout).toContain(`CONFIG_DIR:${join(profilesRoot, "profiles", "work")}`);
    expect(stderr).toMatch(/not logged in/i);
  });

  it("fails without modifying the shell when the Alias is unknown", () => {
    const { stdout, stderr, status } = runInZsh(
      `source ${JSON.stringify(join(repoRoot, "shell", "ccp.sh"))}
       ccp use ghost
       echo "STATUS:$?"
       echo "CONFIG_DIR:${"$"}{CLAUDE_CONFIG_DIR:-<unset>}"
       echo STILL_ALIVE`,
      JSON.stringify({ loggedIn: true, email: "work@example.com", orgName: "Work Org" }),
    );

    expect(status).toBe(0); // the outer zsh -c itself still exits cleanly
    expect(stdout).toContain("STATUS:1");
    expect(stdout).toContain("CONFIG_DIR:<unset>");
    expect(stdout).toContain("STILL_ALIVE");
    expect(stderr).toMatch(/unknown alias 'ghost'/i);
  });

  it("fails without hanging, and leaves the shell unchanged, when `ccp use` is given no Alias outside an interactive terminal", () => {
    // `spawnSync` never attaches a pty, so this is the real non-interactive path ticket #9's own
    // acceptance criterion describes — not a simulation of it. If the picker ever blocked on
    // stdin here instead of rejecting immediately, this test would hang until vitest's own
    // timeout killed it.
    const { stdout, stderr, status } = runInZsh(
      `source ${JSON.stringify(join(repoRoot, "shell", "ccp.sh"))}
       ccp add work >/dev/null
       ccp use
       echo "STATUS:$?"
       echo "CONFIG_DIR:${"$"}{CLAUDE_CONFIG_DIR:-<unset>}"
       echo STILL_ALIVE`,
      JSON.stringify({ loggedIn: true, email: "work@example.com", orgName: "Work Org" }),
    );

    expect(status).toBe(0);
    expect(stdout).toContain("STATUS:1");
    expect(stdout).toContain("CONFIG_DIR:<unset>");
    expect(stdout).toContain("STILL_ALIVE");
    expect(stderr).toMatch(/interactive terminal/i);
  });

  it("lets two shells bound to different Profiles each report their own Account and Organization, undisturbed by the other", () => {
    // Two separate zsh processes — as close as a single test gets to "two shells at once" —
    // each adding then binding then immediately asking `ccp whoami`, the actual command
    // CONTEXT.md's Binding is meant to serve.
    const alpha = runInZsh(
      `source ${JSON.stringify(join(repoRoot, "shell", "ccp.sh"))}
       ccp add alpha >/dev/null
       ccp use alpha
       ccp whoami`,
      "",
    );
    const beta = runInZsh(
      `source ${JSON.stringify(join(repoRoot, "shell", "ccp.sh"))}
       ccp add beta >/dev/null
       ccp use beta
       ccp whoami`,
      "",
    );

    expect(alpha.stdout).toMatch(/Alias:\s+alpha\b/);
    expect(alpha.stdout).toContain("alpha@example.com");
    expect(alpha.stdout).not.toContain("beta");

    expect(beta.stdout).toMatch(/Alias:\s+beta\b/);
    expect(beta.stdout).toContain("beta@example.com");
    expect(beta.stdout).not.toContain("alpha");
  });
});
