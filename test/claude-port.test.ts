import { describe, expect, it } from "vitest";
import { ClaudeCliPort } from "../src/claude-port.js";
import type { InteractiveProcessResult, InteractiveProcessRunner, ProcessResult, ProcessRunner } from "../src/claude-port.js";

function fakeRun(result: ProcessResult, capture?: { command?: string; args?: string[]; env?: NodeJS.ProcessEnv }): ProcessRunner {
  return async (command, args, options) => {
    if (capture) {
      capture.command = command;
      capture.args = args;
      capture.env = options.env;
    }
    return result;
  };
}

function fakeRunInteractive(
  result: InteractiveProcessResult,
  capture?: { command?: string; args?: string[]; env?: NodeJS.ProcessEnv },
): InteractiveProcessRunner {
  return async (command, args, options) => {
    if (capture) {
      capture.command = command;
      capture.args = args;
      capture.env = options.env;
    }
    return result;
  };
}

describe("ClaudeCliPort.authStatus", () => {
  it("invokes `claude auth status --json`", async () => {
    const capture: { command?: string; args?: string[] } = {};
    const port = new ClaudeCliPort({
      run: fakeRun({ stdout: '{"loggedIn": false, "authMethod": "none", "apiProvider": "firstParty"}', stderr: "", exitCode: 1 }, capture),
    });

    await port.authStatus();

    expect(capture.command).toBe("claude");
    expect(capture.args).toEqual(["auth", "status", "--json"]);
  });

  it("parses a logged-in response into an Identity (Account email, Organization orgName)", async () => {
    const port = new ClaudeCliPort({
      run: fakeRun({
        stdout: JSON.stringify({
          loggedIn: true,
          authMethod: "claude.ai",
          apiProvider: "firstParty",
          email: "dev@example.com",
          orgId: "org_123",
          orgName: "Acme Corp",
          subscriptionType: "team",
        }),
        stderr: "",
        exitCode: 0,
      }),
    });

    await expect(port.authStatus()).resolves.toEqual({
      loggedIn: true,
      identity: { email: "dev@example.com", orgName: "Acme Corp" },
    });
  });

  it("narrows a logged-in response missing email or orgName to identity: null (issue #48, ADR-0014)", async () => {
    const port = new ClaudeCliPort({
      run: fakeRun({
        stdout: JSON.stringify({ loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty" }),
        stderr: "",
        exitCode: 0,
      }),
    });

    await expect(port.authStatus()).resolves.toEqual({ loggedIn: true, identity: null });
  });

  it("treats exit code 1 with a well-shaped logged-out response as success, not an error", async () => {
    // Verified by probe: `claude auth status --json` exits 1 for a perfectly normal logged-out
    // Profile (see ADR-0005). Success must be judged by output shape, never by exit code.
    const port = new ClaudeCliPort({
      run: fakeRun({
        stdout: '{"loggedIn": false, "authMethod": "none", "apiProvider": "firstParty"}',
        stderr: "",
        exitCode: 1,
      }),
    });

    await expect(port.authStatus()).resolves.toEqual({ loggedIn: false });
  });

  it("sets CLAUDE_CONFIG_DIR to the given directory when resolving a bound Profile's identity", async () => {
    const capture: { env?: NodeJS.ProcessEnv } = {};
    const port = new ClaudeCliPort({
      run: fakeRun({ stdout: '{"loggedIn": false}', stderr: "", exitCode: 1 }, capture),
    });

    await port.authStatus("/profiles/work");

    expect(capture.env?.CLAUDE_CONFIG_DIR).toBe("/profiles/work");
  });

  it("leaves CLAUDE_CONFIG_DIR untouched (deferring to the ambient environment) when no directory is given", async () => {
    const originalValue = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = "/should-pass-through";
    try {
      const capture: { env?: NodeJS.ProcessEnv } = {};
      const port = new ClaudeCliPort({
        run: fakeRun({ stdout: '{"loggedIn": false}', stderr: "", exitCode: 1 }, capture),
      });

      await port.authStatus();

      expect(capture.env?.CLAUDE_CONFIG_DIR).toBe("/should-pass-through");
    } finally {
      if (originalValue === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = originalValue;
    }
  });

  it("throws a diagnostic error when stdout isn't parseable JSON", async () => {
    const port = new ClaudeCliPort({
      run: fakeRun({ stdout: "not json", stderr: "some warning", exitCode: 1 }),
    });

    await expect(port.authStatus()).rejects.toThrow(/claude auth status --json/i);
  });

  it("throws a diagnostic error when the JSON is well-formed but missing 'loggedIn'", async () => {
    const port = new ClaudeCliPort({
      run: fakeRun({ stdout: '{"unexpected": true}', stderr: "", exitCode: 0 }),
    });

    await expect(port.authStatus()).rejects.toThrow(/unexpected/i);
  });

  it("names Claude Code having changed and points at 'ccp doctor' when stdout isn't parseable JSON (issue #34)", async () => {
    const port = new ClaudeCliPort({
      run: fakeRun({ stdout: "not json", stderr: "", exitCode: 1 }),
    });

    await expect(port.authStatus()).rejects.toThrow(/claude code.*changed.*ccp doctor/is);
  });

  it("names Claude Code having changed and points at 'ccp doctor' when the JSON is missing 'loggedIn' (issue #34)", async () => {
    const port = new ClaudeCliPort({
      run: fakeRun({ stdout: '{"unexpected": true}', stderr: "", exitCode: 0 }),
    });

    await expect(port.authStatus()).rejects.toThrow(/claude code.*changed.*ccp doctor/is);
  });

  it("propagates a process-runner rejection (e.g. the claude binary is missing) unchanged", async () => {
    const port = new ClaudeCliPort({
      run: async () => {
        throw new Error("spawn claude ENOENT");
      },
    });

    await expect(port.authStatus()).rejects.toThrow(/ENOENT/);
  });
});

describe("ClaudeCliPort.login", () => {
  it("invokes `claude auth login`", async () => {
    const capture: { command?: string; args?: string[] } = {};
    const port = new ClaudeCliPort({
      runInteractive: fakeRunInteractive({ exitCode: 0 }, capture),
    });

    await port.login();

    expect(capture.command).toBe("claude");
    expect(capture.args).toEqual(["auth", "login"]);
  });

  it("sets CLAUDE_CONFIG_DIR to the given directory when logging in a bound Profile", async () => {
    const capture: { env?: NodeJS.ProcessEnv } = {};
    const port = new ClaudeCliPort({
      runInteractive: fakeRunInteractive({ exitCode: 0 }, capture),
    });

    await port.login("/profiles/work");

    expect(capture.env?.CLAUDE_CONFIG_DIR).toBe("/profiles/work");
  });

  it("leaves CLAUDE_CONFIG_DIR untouched (deferring to the ambient environment) when no directory is given", async () => {
    const originalValue = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = "/should-pass-through";
    try {
      const capture: { env?: NodeJS.ProcessEnv } = {};
      const port = new ClaudeCliPort({
        runInteractive: fakeRunInteractive({ exitCode: 0 }, capture),
      });

      await port.login();

      expect(capture.env?.CLAUDE_CONFIG_DIR).toBe("/should-pass-through");
    } finally {
      if (originalValue === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = originalValue;
    }
  });

  it("resolves when the login flow exits 0", async () => {
    const port = new ClaudeCliPort({
      runInteractive: fakeRunInteractive({ exitCode: 0 }),
    });

    await expect(port.login()).resolves.toBeUndefined();
  });

  it("throws when the login flow exits non-zero", async () => {
    const port = new ClaudeCliPort({
      runInteractive: fakeRunInteractive({ exitCode: 1 }),
    });

    await expect(port.login()).rejects.toThrow(/exited with code 1/);
  });

  it("propagates a process-runner rejection (e.g. the claude binary is missing) unchanged", async () => {
    const port = new ClaudeCliPort({
      runInteractive: async () => {
        throw new Error("spawn claude ENOENT");
      },
    });

    await expect(port.login()).rejects.toThrow(/ENOENT/);
  });
});

describe("ClaudeCliPort.version", () => {
  it("invokes `claude --version`", async () => {
    const capture: { command?: string; args?: string[] } = {};
    const port = new ClaudeCliPort({
      run: fakeRun({ stdout: "2.1.224 (Claude Code)\n", stderr: "", exitCode: 0 }, capture),
    });

    await port.version();

    expect(capture.command).toBe("claude");
    expect(capture.args).toEqual(["--version"]);
  });

  it("resolves the trimmed stdout", async () => {
    const port = new ClaudeCliPort({
      run: fakeRun({ stdout: "2.1.224 (Claude Code)\n", stderr: "", exitCode: 0 }),
    });

    await expect(port.version()).resolves.toBe("2.1.224 (Claude Code)");
  });

  it("throws a diagnostic error when stdout is empty", async () => {
    const port = new ClaudeCliPort({
      run: fakeRun({ stdout: "", stderr: "", exitCode: 0 }),
    });

    await expect(port.version()).rejects.toThrow(/claude --version/i);
  });

  it("propagates a process-runner rejection (e.g. the claude binary is missing) unchanged", async () => {
    const port = new ClaudeCliPort({
      run: async () => {
        throw new Error("spawn claude ENOENT");
      },
    });

    await expect(port.version()).rejects.toThrow(/ENOENT/);
  });
});
