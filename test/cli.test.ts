import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultShellRcPath, runCli } from "../src/cli.js";
import { captureLines, fakeClaudePort } from "./commands/shared.js";

describe("runCli", () => {
  it("prints usage to stdout and exits 0 on a bare invocation", async () => {
    const { stdout, stderr, stdoutFn, stderrFn } = captureLines();

    const code = await runCli([], { stdout: stdoutFn, stderr: stderrFn });

    expect(code).toBe(0);
    expect(stdout.join("\n")).toMatch(/usage/i);
    expect(stderr).toEqual([]);
  });

  it("prints usage to stdout and exits 0 on --help", async () => {
    const { stdout, stdoutFn, stderrFn } = captureLines();

    const code = await runCli(["--help"], { stdout: stdoutFn, stderr: stderrFn });

    expect(code).toBe(0);
    expect(stdout.join("\n")).toMatch(/usage/i);
  });

  it("prints the package version to stdout and exits 0 on --version", async () => {
    const { stdout, stderr, stdoutFn, stderrFn } = captureLines();
    const declared = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")).version;

    const code = await runCli(["--version"], { stdout: stdoutFn, stderr: stderrFn });

    expect(code).toBe(0);
    // Bare — nothing but the version, so `ccp --version` is usable in a bug report or a script.
    expect(stdout).toEqual([declared]);
    expect(stderr).toEqual([]);
  });

  it("reports an unknown command to stderr, never stdout, and exits 1", async () => {
    const { stdout, stderr, stdoutFn, stderrFn } = captureLines();

    const code = await runCli(["destroy"], { stdout: stdoutFn, stderr: stderrFn });

    expect(code).toBe(1);
    expect(stdout).toEqual([]);
    expect(stderr.join("\n")).toMatch(/unknown command 'destroy'/i);
  });
});

describe("defaultShellRcPath (issue #40, ADR-0012)", () => {
  it("resolves ~/.bashrc when $SHELL names bash", () => {
    expect(defaultShellRcPath({ SHELL: "/bin/bash" })).toBe(join(homedir(), ".bashrc"));
  });

  it("resolves ~/.zshrc when $SHELL names zsh and $ZDOTDIR is unset", () => {
    expect(defaultShellRcPath({ SHELL: "/usr/bin/zsh" })).toBe(join(homedir(), ".zshrc"));
  });

  it("prefers $ZDOTDIR/.zshrc over ~/.zshrc when $SHELL names zsh", () => {
    expect(defaultShellRcPath({ SHELL: "/usr/bin/zsh", ZDOTDIR: "/custom/zdotdir" })).toBe(join("/custom/zdotdir", ".zshrc"));
  });

  it("resolves ~/.bashrc when $SHELL is unset — bash is the fallback, never zsh", () => {
    expect(defaultShellRcPath({})).toBe(join(homedir(), ".bashrc"));
  });

  it("resolves ~/.bashrc for an unrecognized $SHELL, e.g. fish", () => {
    expect(defaultShellRcPath({ SHELL: "/usr/bin/fish" })).toBe(join(homedir(), ".bashrc"));
  });

  it("ignores $ZDOTDIR entirely when $SHELL doesn't name zsh — bash never reads a zsh dot-directory", () => {
    expect(defaultShellRcPath({ SHELL: "/bin/bash", ZDOTDIR: "/custom/zdotdir" })).toBe(join(homedir(), ".bashrc"));
  });

  it("keys off $SHELL alone, never off process.platform — same result regardless of the running platform", () => {
    // defaultShellRcPath takes no platform argument at all, so there is nothing platform-specific
    // to vary here: the same env resolves the same path on darwin and linux (issue #40's "one
    // code path, not a macOS path and a separate Linux path").
    expect(defaultShellRcPath({ SHELL: "/bin/bash" })).toBe(join(homedir(), ".bashrc"));
  });
});

describe("runCli Windows guard (issue #40, ADR-0012)", () => {
  let stateDir: string;
  let installDir: string;

  beforeEach(async () => {
    // stateDir itself deliberately doesn't exist yet (unlike its parent) — mirrors a machine
    // that's never run `ccp add`/`ccp login`, so a `stat` on it staying rejected after the guard
    // proves nothing was created, not merely that an already-existing directory was left alone.
    stateDir = join(await mkdtemp(join(tmpdir(), "ccp-cli-windows-test-")), "ccp");
    installDir = await mkdtemp(join(tmpdir(), "ccp-cli-windows-install-"));
  });

  afterEach(async () => {
    await rm(stateDir, { recursive: true, force: true });
    await rm(installDir, { recursive: true, force: true });
  });

  /** Every argv this suite checks is guarded identically — a representative subcommand from each
   * shape `runCli` dispatches (a bare command, one that takes an alias, one that takes flags, and
   * an unrecognised command), not just `setup`, per issue #40's own acceptance criteria. */
  const GUARDED_ARGVS = [
    ["setup"],
    ["doctor"],
    ["whoami"],
    ["add", "work"],
    ["ls"],
    ["login", "work"],
    ["use", "work"],
    ["shell-init"],
    ["run", "work", "--", "echo", "hi"],
    ["reconcile", "work"],
    ["sync"],
    ["rm", "work", "--yes"],
    ["teardown"],
    ["nonexistent-command"],
  ];

  it.each(GUARDED_ARGVS)("guards '%s' before it touches anything", async (...argv) => {
    const { stdout, stderr, stdoutFn, stderrFn } = captureLines();

    const code = await runCli(argv, { platform: "win32", stateDir, installDir, stdout: stdoutFn, stderr: stderrFn });

    expect(code).not.toBe(0);
    expect(stdout).toEqual([]);
    expect(stderr.join("\n")).toMatch(/windows.*support/i);
    // No Check ran, no file was written: the state directory `ccp add`/`ccp login` would
    // otherwise create never gets created.
    await expect(stat(stateDir)).rejects.toThrow();
  });

  it("names WSL and the install-inside-the-distro requirement — the guard is the only channel to a Windows user", async () => {
    const { stderr, stdoutFn, stderrFn } = captureLines();

    await runCli(["setup"], { platform: "win32", stateDir, installDir, stdout: stdoutFn, stderr: stderrFn });

    // `doctor` never runs on `win32` (the guard sits ahead of every subcommand), so nothing else
    // can carry this guidance — see ADR-0013. Both halves are asserted: WSL as the remedy, and
    // that Claude Code belongs inside the distro, without which a Windows-side `claude` reached
    // through WSL's PATH interop produces a Phantom binding (CONTEXT.md).
    expect(stderr.join("\n")).toMatch(/WSL/);
    expect(stderr.join("\n")).toMatch(/not on the Windows side/i);
  });

  it("prints the guard message to stderr, never stdout — ADR-0004's discipline applies here too", async () => {
    const { stdout, stderr, stdoutFn, stderrFn } = captureLines();

    await runCli(["setup"], { platform: "win32", stateDir, installDir, stdout: stdoutFn, stderr: stderrFn });

    expect(stdout).toEqual([]);
    expect(stderr.length).toBeGreaterThan(0);
  });

  it("never touches a Profile's registry, even for a command that would otherwise create one", async () => {
    await runCli(["add", "work"], { platform: "win32", stateDir, installDir, stdout: () => {}, stderr: () => {} });

    await expect(stat(stateDir)).rejects.toThrow();
  });

  it("still prints usage on a bare invocation — the guard sits after usage/version, not before", async () => {
    const { stdout, stderr, stdoutFn, stderrFn } = captureLines();

    const code = await runCli([], { platform: "win32", stdout: stdoutFn, stderr: stderrFn });

    expect(code).toBe(0);
    expect(stdout.join("\n")).toMatch(/usage/i);
    expect(stderr).toEqual([]);
  });

  it("still reports --version — a flag, not a subcommand that touches anything", async () => {
    const { stdout, stderr, stdoutFn, stderrFn } = captureLines();

    const code = await runCli(["--version"], { platform: "win32", stdout: stdoutFn, stderr: stderrFn });

    expect(code).toBe(0);
    expect(stderr).toEqual([]);
    expect(stdout).toHaveLength(1);
  });

  it("never guards on darwin or linux — only win32 triggers it", async () => {
    const claudePort = fakeClaudePort({ loggedIn: false });
    const { stdout, stderr, stdoutFn, stderrFn } = captureLines();

    const code = await runCli(["ls"], { platform: "darwin", stateDir, installDir, claudePort, stdout: stdoutFn, stderr: stderrFn });

    expect(code).toBe(0);
    expect(stderr.join("\n")).not.toMatch(/windows/i);
  });
});
