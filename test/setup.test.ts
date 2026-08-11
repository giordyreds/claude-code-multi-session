import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SHELL_WIRING_LINE } from "../src/doctor.js";
import { removeShellWiringLine, writeShellWiringLine } from "../src/setup.js";

describe("writeShellWiringLine", () => {
  let root: string;
  let zshrcPath: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "ccp-setup-test-"));
    zshrcPath = join(root, ".zshrc");
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("writes the guarded line to a file that lacks it", async () => {
    await writeFile(zshrcPath, "# my zshrc\n", "utf8");

    const result = await writeShellWiringLine(zshrcPath);

    expect(result).toEqual({ added: true });
    expect(await readFile(zshrcPath, "utf8")).toBe(`# my zshrc\n${SHELL_WIRING_LINE}\n`);
  });

  it("creates the file when it doesn't exist yet", async () => {
    const result = await writeShellWiringLine(zshrcPath);

    expect(result).toEqual({ added: true });
    expect(await readFile(zshrcPath, "utf8")).toBe(`${SHELL_WIRING_LINE}\n`);
  });

  it("creates the parent directory when it doesn't exist yet, matching a from-scratch machine", async () => {
    const nested = join(root, "nested", "dir", ".zshrc");

    await writeShellWiringLine(nested);

    expect(await readFile(nested, "utf8")).toBe(`${SHELL_WIRING_LINE}\n`);
  });

  it("adds a leading newline when the existing content doesn't already end in one", async () => {
    await writeFile(zshrcPath, "# my zshrc, no trailing newline", "utf8");

    await writeShellWiringLine(zshrcPath);

    expect(await readFile(zshrcPath, "utf8")).toBe(`# my zshrc, no trailing newline\n${SHELL_WIRING_LINE}\n`);
  });

  it("writes nothing on a second run — idempotent", async () => {
    await writeFile(zshrcPath, `# my zshrc\n${SHELL_WIRING_LINE}\n`, "utf8");
    const before = await readFile(zshrcPath, "utf8");

    const result = await writeShellWiringLine(zshrcPath);

    expect(result).toEqual({ added: false });
    expect(await readFile(zshrcPath, "utf8")).toBe(before);
  });

  it("propagates a real filesystem error rather than swallowing it", async () => {
    const notADir = join(root, "not-a-directory");
    await writeFile(notADir, "x", "utf8");

    await expect(writeShellWiringLine(join(notADir, ".zshrc"))).rejects.toThrow();
  });
});

describe("removeShellWiringLine", () => {
  let root: string;
  let zshrcPath: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "ccp-setup-test-"));
    zshrcPath = join(root, ".zshrc");
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("removes the line it added, leaving unrelated content untouched", async () => {
    await writeFile(zshrcPath, `# before\nexport FOO=bar\n${SHELL_WIRING_LINE}\n# after\n`, "utf8");

    const result = await removeShellWiringLine(zshrcPath);

    expect(result).toEqual({ removed: true });
    expect(await readFile(zshrcPath, "utf8")).toBe("# before\nexport FOO=bar\n# after\n");
  });

  it("is safe to run when no line is present, and leaves the file untouched", async () => {
    const contents = "# my zshrc, never had the line\n";
    await writeFile(zshrcPath, contents, "utf8");

    const result = await removeShellWiringLine(zshrcPath);

    expect(result).toEqual({ removed: false });
    expect(await readFile(zshrcPath, "utf8")).toBe(contents);
  });

  it("is safe to run when the file doesn't exist at all", async () => {
    const result = await removeShellWiringLine(zshrcPath);

    expect(result).toEqual({ removed: false });
    await expect(stat(zshrcPath)).rejects.toThrow();
  });

  it("removes every occurrence of the exact line, not just the first", async () => {
    await writeFile(zshrcPath, `${SHELL_WIRING_LINE}\n# middle\n${SHELL_WIRING_LINE}\n`, "utf8");

    await removeShellWiringLine(zshrcPath);

    expect(await readFile(zshrcPath, "utf8")).toBe("# middle\n");
  });

  it("propagates a real filesystem error rather than misreporting it as 'nothing to remove'", async () => {
    const notADir = join(root, "not-a-directory");
    await writeFile(notADir, "x", "utf8");

    await expect(removeShellWiringLine(join(notADir, "child"))).rejects.toThrow();
  });
});

describe("writeShellWiringLine and removeShellWiringLine round-trip", () => {
  it("leaves the file exactly as it started once written then removed", async () => {
    const root = await mkdtemp(join(tmpdir(), "ccp-setup-test-"));
    const zshrcPath = join(root, ".zshrc");
    try {
      const original = "# my existing zshrc\nexport PATH=\"$PATH:/usr/local/bin\"\n";
      await writeFile(zshrcPath, original, "utf8");

      await writeShellWiringLine(zshrcPath);
      await removeShellWiringLine(zshrcPath);

      expect(await readFile(zshrcPath, "utf8")).toBe(original);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
