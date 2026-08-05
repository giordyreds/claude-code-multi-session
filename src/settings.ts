import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/** A parsed settings file's shape: strict JSON, so every value is JSON-safe. */
export type SettingsValue = Record<string, unknown>;

/**
 * The reserved top-level key that marks a settings file as this tool's own rendered output — see
 * ADR-0002 amendment 2. Must be a key, never a comment: the settings file is strict JSON, and a
 * `//` header breaks it silently (verified by Spike 0001), leaving settings quietly unapplied.
 */
export const GENERATED_MARKER_KEY = "$ccpGenerated";

/**
 * The marker's value: a full snapshot of everything this render wrote *itself* (excluding keys
 * preserved from Claude Code's own runtime writes — see {@link pickUnmanagedKeys}), so the *next*
 * render can tell a genuine hand-edit (a managed key no longer matches its snapshot) apart from a
 * runtime write (an unrecognized key appears alongside the managed ones — Spike 0001's `"tui"`
 * finding). Self-contained in the one file on purpose: a sidecar snapshot file could go out of
 * sync with the settings file it describes (deleted, copied, or restored independently), where an
 * embedded one cannot.
 */
interface GeneratedMarker {
  snapshot: SettingsValue;
}

export interface RenderSettingsOptions {
  /** Path to the live base settings file — the Default install's, per ADR-0002/0003. A missing
   * file reads as an empty base (nothing rendered yet), matching this project's convention
   * elsewhere (registry.ts) that absence is normal state, not an error. */
  baseSettingsPath: string;
  /** Path to this Profile's optional override file. Most Profiles override nothing, so a missing
   * file reads as an empty override rather than a required one. */
  overrideSettingsPath?: string;
  /** Path this Profile's effective settings file is rendered to. */
  outputSettingsPath: string;
}

export interface RenderSettingsResult {
  /** The full rendered content, including {@link GENERATED_MARKER_KEY}, exactly as verified
   * on disk by parsing it back. */
  settings: SettingsValue;
  /** Whether this render actually wrote the file — false when the newly computed content is
   * identical to what was already there (base and override unchanged since the last render), so
   * `ccp sync` can report "no changes" on a repeat run instead of a write that changed nothing. */
  changed: boolean;
}

/**
 * Renders `outputSettingsPath` from the live base plus an optional per-Profile override
 * (ADR-0002). Refuses to overwrite a hand-edit — a file whose managed keys no longer match what
 * was last rendered, or that was never rendered by this tool at all — since silently clobbering
 * it is exactly the drift-by-accident ADR-0002 is layering settings to avoid.
 *
 * Any key Claude Code itself wrote at runtime and that no prior render ever managed (its `"tui"`
 * key, per Spike 0001's amendment 1) is carried forward into the new render rather than dropped:
 * distinguishing a runtime write from a hand-edit is pointless if the render then erases it
 * anyway on every ordinary use.
 *
 * Writes are verified by parsing the file back before the render is treated as successful: the
 * settings file is strict JSON with no error channel for malformed content (Spike 0001), so a
 * renderer that trusts `writeFile` resolving could ship a file that silently fails to apply.
 */
export async function renderSettings(options: RenderSettingsOptions): Promise<RenderSettingsResult> {
  const [base, override, existing] = await Promise.all([
    readJsonObjectOrDefault<SettingsValue>(options.baseSettingsPath, {}),
    options.overrideSettingsPath
      ? readJsonObjectOrDefault<SettingsValue>(options.overrideSettingsPath, {})
      : Promise.resolve<SettingsValue>({}),
    readJsonObjectOrDefault<undefined>(options.outputSettingsPath, undefined),
  ]);

  if (existing) {
    assertNoHandEdit(options.outputSettingsPath, existing);
  }

  const merged = mergeSettings(base, override);
  const preserved = existing ? pickUnmanagedKeys(existing) : {};
  const marker: GeneratedMarker = { snapshot: merged };
  const rendered: SettingsValue = { ...preserved, ...merged, [GENERATED_MARKER_KEY]: marker };

  if (existing && deepEqual(existing, rendered)) {
    return { settings: rendered, changed: false };
  }

  await mkdir(dirname(options.outputSettingsPath), { recursive: true });
  const serialized = `${JSON.stringify(rendered, null, 2)}\n`;
  await writeFile(options.outputSettingsPath, serialized, "utf8");

  await verifyRoundTrip(options.outputSettingsPath, rendered);

  return { settings: rendered, changed: true };
}

/**
 * Merges `override` onto `base` one level deep: an object-valued key present in both is merged
 * key-by-key at that one nested level, while every other key — scalars, arrays, and keys present
 * in only one side — is taken wholesale. This is what lets a Profile override a single
 * entitlement-sensitive value (e.g. `model`) without repeating shared groups like `hooks` and
 * `permissions`, and what keeps a deep merge from reaching further than the file's own nesting
 * warrants (issue #7's acceptance criteria call out one level, not arbitrary depth).
 */
export function mergeSettings(base: SettingsValue, override: SettingsValue): SettingsValue {
  const merged: SettingsValue = { ...base };

  for (const [key, overrideValue] of Object.entries(override)) {
    const baseValue = base[key];
    merged[key] =
      isPlainObject(baseValue) && isPlainObject(overrideValue) ? { ...baseValue, ...overrideValue } : overrideValue;
  }

  return merged;
}

/** Reads and parses a settings file, resolving `whenMissing` rather than throwing when it doesn't
 * exist — the right default for a base, an override, and a not-yet-rendered output alike (see
 * {@link RenderSettingsOptions}'s field docs), matching this project's convention elsewhere
 * (registry.ts's `loadRegistry`) that absence is normal state. A present-but-malformed file still
 * throws: this project never guesses at broken JSON, it names the file and stops. */
async function readJsonObjectOrDefault<T>(path: string, whenMissing: T): Promise<SettingsValue | T> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    if (isErrnoException(err) && err.code === "ENOENT") return whenMissing;
    throw new Error(`Could not read settings at '${path}': ${err instanceof Error ? err.message : String(err)}`);
  }

  return parseSettingsObject(raw, path);
}

function parseSettingsObject(raw: string, path: string): SettingsValue {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`The settings file at '${path}' is not valid JSON. Fix or remove it before continuing.`);
  }

  if (!isPlainObject(parsed)) {
    throw new Error(`The settings file at '${path}' is malformed (expected a JSON object). Fix or remove it before continuing.`);
  }

  return parsed;
}

/**
 * Refuses a render whose target already holds content this tool didn't produce, or no longer
 * matches what it last produced. Only keys the last render actually wrote — its snapshot — are
 * checked; an unrecognized key present now and absent from the snapshot is a runtime write, not a
 * hand-edit (see {@link pickUnmanagedKeys}), so ordinary use of a Profile never blocks its next
 * re-render.
 */
function assertNoHandEdit(path: string, existing: SettingsValue): void {
  const marker = existing[GENERATED_MARKER_KEY];
  if (!isGeneratedMarker(marker)) {
    throw new Error(
      `'${path}' already exists and wasn't generated by this tool (no '${GENERATED_MARKER_KEY}' marker found). ` +
        "Move whatever it should contain into the base settings or this Profile's override, then remove it so it can be rendered.",
    );
  }

  const changedKeys = Object.keys(marker.snapshot).filter((key) => !deepEqual(existing[key], marker.snapshot[key]));
  if (changedKeys.length > 0) {
    throw new Error(
      `'${path}' was hand-edited since it was last rendered (changed: ${changedKeys.join(", ")}). ` +
        "Move the change into the base settings or this Profile's override instead of editing the rendered file directly, then re-render.",
    );
  }
}

/**
 * Picks `existing`'s keys that no prior render ever managed — i.e. that aren't named in its own
 * {@link GENERATED_MARKER_KEY} snapshot — so a fresh render can carry them forward instead of
 * erasing them. This is how Claude Code's own runtime writes (Spike 0001's `"tui"` key) survive
 * ordinary re-rendering: they were never part of any snapshot, so they never look like a key the
 * base or override removed on purpose, only ever like a key this renderer never touched.
 */
function pickUnmanagedKeys(existing: SettingsValue): SettingsValue {
  const marker = existing[GENERATED_MARKER_KEY];
  const previouslyManaged = new Set(isGeneratedMarker(marker) ? Object.keys(marker.snapshot) : []);

  const preserved: SettingsValue = {};
  for (const [key, value] of Object.entries(existing)) {
    if (key === GENERATED_MARKER_KEY || previouslyManaged.has(key)) continue;
    preserved[key] = value;
  }
  return preserved;
}

/** Parses the file this render just wrote and checks it matches what was intended, because a
 * malformed settings file produces no error of its own — it just silently fails to apply (Spike
 * 0001's amendment 2). A renderer that stops at `writeFile` resolving cannot tell "wrote fine"
 * from "wrote something Claude Code will quietly ignore." */
async function verifyRoundTrip(path: string, rendered: SettingsValue): Promise<void> {
  const raw = await readFile(path, "utf8");

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Rendering '${path}' failed: the file that was written is not valid JSON.`);
  }

  if (!deepEqual(parsed, rendered)) {
    throw new Error(`Rendering '${path}' failed: the file that was written doesn't parse back to what was rendered.`);
  }
}

function isGeneratedMarker(value: unknown): value is GeneratedMarker {
  return isPlainObject(value) && isPlainObject(value.snapshot);
}

function isPlainObject(value: unknown): value is SettingsValue {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;

  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((value, index) => deepEqual(value, b[index]));
  }

  if (isPlainObject(a) && isPlainObject(b)) {
    const aKeys = Object.keys(a);
    const bKeys = Object.keys(b);
    if (aKeys.length !== bKeys.length) return false;
    return aKeys.every((key) => Object.hasOwn(b, key) && deepEqual(a[key], b[key]));
  }

  return false;
}

function isErrnoException(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && "code" in err;
}
