import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GENERATED_MARKER_KEY, mergeSettings, renderSettings } from "../src/settings.js";

describe("mergeSettings", () => {
  it("returns the base unchanged when the override is empty", () => {
    const base = { model: "sonnet", hooks: { onStart: ["a"] } };
    expect(mergeSettings(base, {})).toEqual(base);
  });

  it("replaces a scalar top-level key wholesale", () => {
    const base = { model: "sonnet" };
    expect(mergeSettings(base, { model: "opus" })).toEqual({ model: "opus" });
  });

  it("merges an object-valued key one level deep, keeping base-only nested keys", () => {
    const base = { permissions: { allow: ["a"], deny: ["b"] } };
    const override = { permissions: { allow: ["c"] } };
    expect(mergeSettings(base, override)).toEqual({ permissions: { allow: ["c"], deny: ["b"] } });
  });

  it("replaces an array-valued key wholesale rather than concatenating", () => {
    const base = { hooks: { onStart: ["a", "b"] } };
    const override = { hooks: { onStart: ["c"] } };
    expect(mergeSettings(base, override)).toEqual({ hooks: { onStart: ["c"] } });
  });

  it("carries over a base-only key untouched, so shared groups need no duplication in the override", () => {
    const base = { hooks: { onStart: ["a"] }, permissions: { allow: ["a"] }, model: "sonnet" };
    const override = { model: "opus" };
    expect(mergeSettings(base, override)).toEqual({
      hooks: { onStart: ["a"] },
      permissions: { allow: ["a"] },
      model: "opus",
    });
  });

  it("adds an override-only key that isn't present in the base at all", () => {
    expect(mergeSettings({}, { model: "opus" })).toEqual({ model: "opus" });
  });

  it("doesn't mutate either input", () => {
    const base = { permissions: { allow: ["a"] } };
    const override = { permissions: { allow: ["b"] } };
    mergeSettings(base, override);
    expect(base).toEqual({ permissions: { allow: ["a"] } });
    expect(override).toEqual({ permissions: { allow: ["b"] } });
  });
});

describe("renderSettings", () => {
  let dir: string;
  let basePath: string;
  let overridePath: string;
  let outputPath: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "ccp-settings-test-"));
    basePath = join(dir, "base.json");
    overridePath = join(dir, "override.json");
    outputPath = join(dir, "profiles", "work", "settings.json");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("renders from the base alone when no override file exists", async () => {
    await writeFile(basePath, JSON.stringify({ model: "sonnet", hooks: { onStart: ["a"] } }), "utf8");

    const result = await renderSettings({ baseSettingsPath: basePath, outputSettingsPath: outputPath });

    expect(result.settings.model).toBe("sonnet");
    expect(result.settings.hooks).toEqual({ onStart: ["a"] });
    expect(result.settings[GENERATED_MARKER_KEY]).toBeDefined();
  });

  it("lets a per-Profile override change only an entitlement-sensitive value", async () => {
    await writeFile(basePath, JSON.stringify({ model: "sonnet", hooks: { onStart: ["a"] } }), "utf8");
    await writeFile(overridePath, JSON.stringify({ model: "opus" }), "utf8");

    const result = await renderSettings({
      baseSettingsPath: basePath,
      overrideSettingsPath: overridePath,
      outputSettingsPath: outputPath,
    });

    expect(result.settings.model).toBe("opus");
    expect(result.settings.hooks).toEqual({ onStart: ["a"] });
  });

  it("treats a missing base or override file as empty rather than an error", async () => {
    const result = await renderSettings({
      baseSettingsPath: basePath,
      overrideSettingsPath: overridePath,
      outputSettingsPath: outputPath,
    });

    expect(result.settings[GENERATED_MARKER_KEY]).toBeDefined();
  });

  it("marks the rendered file with a reserved top-level key, never a comment", async () => {
    await writeFile(basePath, JSON.stringify({ model: "sonnet" }), "utf8");
    await renderSettings({ baseSettingsPath: basePath, outputSettingsPath: outputPath });

    const raw = await readFile(outputPath, "utf8");
    expect(raw).not.toMatch(/\/\//);
    const parsed = JSON.parse(raw);
    expect(parsed[GENERATED_MARKER_KEY]).toBeDefined();
  });

  it("writes a file that parses back to exactly what was rendered", async () => {
    await writeFile(basePath, JSON.stringify({ model: "sonnet", permissions: { allow: ["a"] } }), "utf8");
    const result = await renderSettings({ baseSettingsPath: basePath, outputSettingsPath: outputPath });

    const raw = await readFile(outputPath, "utf8");
    expect(JSON.parse(raw)).toEqual(result.settings);
  });

  it("re-renders cleanly on ordinary repeated use with no hand-edit in between", async () => {
    await writeFile(basePath, JSON.stringify({ model: "sonnet" }), "utf8");
    await renderSettings({ baseSettingsPath: basePath, outputSettingsPath: outputPath });

    await expect(renderSettings({ baseSettingsPath: basePath, outputSettingsPath: outputPath })).resolves.toBeDefined();
  });

  it("reports changed on the first render, and unchanged on an immediate identical re-render", async () => {
    await writeFile(basePath, JSON.stringify({ model: "sonnet" }), "utf8");

    const first = await renderSettings({ baseSettingsPath: basePath, outputSettingsPath: outputPath });
    expect(first.changed).toBe(true);

    const second = await renderSettings({ baseSettingsPath: basePath, outputSettingsPath: outputPath });
    expect(second.changed).toBe(false);
    expect(second.settings).toEqual(first.settings);
  });

  it("reports changed again once the base changes the rendered content", async () => {
    await writeFile(basePath, JSON.stringify({ model: "sonnet" }), "utf8");
    await renderSettings({ baseSettingsPath: basePath, outputSettingsPath: outputPath });

    await writeFile(basePath, JSON.stringify({ model: "haiku" }), "utf8");
    const result = await renderSettings({ baseSettingsPath: basePath, outputSettingsPath: outputPath });

    expect(result.changed).toBe(true);
  });

  it("re-renders without complaint when Claude Code's own runtime write added an unrecognized key, and carries it forward", async () => {
    await writeFile(basePath, JSON.stringify({ model: "sonnet" }), "utf8");
    await renderSettings({ baseSettingsPath: basePath, outputSettingsPath: outputPath });

    const onDisk = JSON.parse(await readFile(outputPath, "utf8"));
    onDisk.tui = { splash: false };
    await writeFile(outputPath, JSON.stringify(onDisk), "utf8");

    const result = await renderSettings({ baseSettingsPath: basePath, outputSettingsPath: outputPath });
    expect(result.settings.model).toBe("sonnet");
    expect(result.settings.tui).toEqual({ splash: false });
  });

  it("drops a key on re-render once the base stops managing it, rather than preserving it forever", async () => {
    await writeFile(basePath, JSON.stringify({ model: "sonnet", permissions: { allow: ["a"] } }), "utf8");
    await renderSettings({ baseSettingsPath: basePath, outputSettingsPath: outputPath });

    await writeFile(basePath, JSON.stringify({ model: "sonnet" }), "utf8");
    const result = await renderSettings({ baseSettingsPath: basePath, outputSettingsPath: outputPath });

    expect(result.settings.permissions).toBeUndefined();
  });

  it("picks up a base change on the next render (the base is read live, not cached)", async () => {
    await writeFile(basePath, JSON.stringify({ model: "sonnet" }), "utf8");
    await renderSettings({ baseSettingsPath: basePath, outputSettingsPath: outputPath });

    await writeFile(basePath, JSON.stringify({ model: "haiku" }), "utf8");
    const result = await renderSettings({ baseSettingsPath: basePath, outputSettingsPath: outputPath });

    expect(result.settings.model).toBe("haiku");
  });

  it("refuses to overwrite a hand-edit to a previously rendered file, and changes nothing on disk", async () => {
    await writeFile(basePath, JSON.stringify({ model: "sonnet" }), "utf8");
    await renderSettings({ baseSettingsPath: basePath, outputSettingsPath: outputPath });

    const before = await readFile(outputPath, "utf8");
    const onDisk = JSON.parse(before);
    onDisk.model = "hand-edited-model";
    await writeFile(outputPath, JSON.stringify(onDisk), "utf8");
    const handEdited = await readFile(outputPath, "utf8");

    await expect(renderSettings({ baseSettingsPath: basePath, outputSettingsPath: outputPath })).rejects.toThrow(
      /hand-edit/i,
    );

    await expect(readFile(outputPath, "utf8")).resolves.toBe(handEdited);
  });

  it("directs a hand-edit's fix into the base settings or the override, not the rendered file", async () => {
    await writeFile(basePath, JSON.stringify({ model: "sonnet" }), "utf8");
    await renderSettings({ baseSettingsPath: basePath, outputSettingsPath: outputPath });

    const onDisk = JSON.parse(await readFile(outputPath, "utf8"));
    onDisk.model = "hand-edited-model";
    await writeFile(outputPath, JSON.stringify(onDisk), "utf8");

    await expect(renderSettings({ baseSettingsPath: basePath, outputSettingsPath: outputPath })).rejects.toThrow(
      /base settings or this Profile's override/i,
    );
  });

  it("refuses to render over a pre-existing file this tool never generated", async () => {
    await writeFile(basePath, JSON.stringify({ model: "sonnet" }), "utf8");
    await mkdir(join(dir, "profiles", "work"), { recursive: true });
    await writeFile(outputPath, JSON.stringify({ model: "someone-elses-file" }), "utf8");

    await expect(renderSettings({ baseSettingsPath: basePath, outputSettingsPath: outputPath })).rejects.toThrow(
      /wasn't generated/i,
    );
  });

  it("throws an actionable error naming the file when the base settings file is malformed", async () => {
    await writeFile(basePath, "not json", "utf8");

    await expect(renderSettings({ baseSettingsPath: basePath, outputSettingsPath: outputPath })).rejects.toThrow(
      new RegExp(basePath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
    );
  });

  it("throws an actionable error naming the file when the override settings file is malformed", async () => {
    await writeFile(basePath, JSON.stringify({ model: "sonnet" }), "utf8");
    await writeFile(overridePath, "not json", "utf8");

    await expect(
      renderSettings({ baseSettingsPath: basePath, overrideSettingsPath: overridePath, outputSettingsPath: outputPath }),
    ).rejects.toThrow(new RegExp(overridePath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  });
});
