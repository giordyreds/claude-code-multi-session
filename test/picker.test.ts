import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { TtyPicker, type PickerKey, type PickerRow } from "../src/picker.js";

/** A fake terminal input: a real `EventEmitter` (so `on`/`removeListener` behave exactly like a
 * stream's) plus the handful of TTY-only members {@link TtyPicker} touches. */
type FakeInput = EventEmitter & {
  isTTY: boolean;
  rawMode: boolean;
  resumed: boolean;
  setRawMode(mode: boolean): void;
  resume(): void;
  pause(): void;
};

function fakeInput(isTTY = true): FakeInput {
  const emitter = new EventEmitter() as FakeInput;
  emitter.isTTY = isTTY;
  emitter.rawMode = false;
  emitter.resumed = false;
  emitter.setRawMode = (mode: boolean) => {
    emitter.rawMode = mode;
  };
  emitter.resume = () => {
    emitter.resumed = true;
  };
  emitter.pause = () => {
    emitter.resumed = false;
  };
  return emitter;
}

function fakeOutput(): { chunks: string[]; write: (chunk: string) => void } {
  const chunks: string[] = [];
  return { chunks, write: (chunk) => chunks.push(chunk) };
}

function press(input: EventEmitter, name: string, extra: Partial<PickerKey> = {}): void {
  input.emit("keypress", undefined, { name, ...extra });
}

const ROWS: PickerRow[] = [
  { alias: "work", label: "work: dev@example.com (Acme Corp)" },
  { alias: "personal", label: "personal: (not logged in)" },
];

describe("TtyPicker", () => {
  it("rejects immediately, drawing nothing, when input isn't an interactive terminal", async () => {
    const input = fakeInput(false);
    const output = fakeOutput();
    const picker = new TtyPicker({ input, output });

    await expect(picker.pick(ROWS)).rejects.toThrow(/interactive terminal/i);
    expect(output.chunks).toEqual([]);
  });

  it("draws every row, on the given output stream only, before any key is pressed", async () => {
    const input = fakeInput();
    const output = fakeOutput();
    const picker = new TtyPicker({ input, output });

    const resultPromise = picker.pick(ROWS);
    const frame = output.chunks.join("");
    expect(frame).toContain("work: dev@example.com (Acme Corp)");
    expect(frame).toContain("personal: (not logged in)");

    press(input, "return");
    await resultPromise;
  });

  it("resolves the highlighted row's Alias on Enter", async () => {
    const input = fakeInput();
    const picker = new TtyPicker({ input, output: fakeOutput() });

    const resultPromise = picker.pick(ROWS);
    press(input, "return");

    await expect(resultPromise).resolves.toBe("work");
  });

  it("moves the selection down and up with the arrow keys before confirming", async () => {
    const input = fakeInput();
    const picker = new TtyPicker({ input, output: fakeOutput() });

    const resultPromise = picker.pick(ROWS);
    press(input, "down");
    press(input, "return");

    await expect(resultPromise).resolves.toBe("personal");
  });

  it("wraps back to the first row after moving down from the last", async () => {
    const input = fakeInput();
    const picker = new TtyPicker({ input, output: fakeOutput() });

    const resultPromise = picker.pick(ROWS);
    press(input, "down");
    press(input, "down");
    press(input, "return");

    await expect(resultPromise).resolves.toBe("work");
  });

  it("resolves undefined on Escape, leaving the caller nothing to bind", async () => {
    const input = fakeInput();
    const picker = new TtyPicker({ input, output: fakeOutput() });

    const resultPromise = picker.pick(ROWS);
    press(input, "escape");

    await expect(resultPromise).resolves.toBeUndefined();
  });

  it("resolves undefined on 'q'", async () => {
    const input = fakeInput();
    const picker = new TtyPicker({ input, output: fakeOutput() });

    const resultPromise = picker.pick(ROWS);
    press(input, "q");

    await expect(resultPromise).resolves.toBeUndefined();
  });

  it("resolves undefined on Ctrl+C", async () => {
    const input = fakeInput();
    const picker = new TtyPicker({ input, output: fakeOutput() });

    const resultPromise = picker.pick(ROWS);
    press(input, "c", { ctrl: true });

    await expect(resultPromise).resolves.toBeUndefined();
  });

  it("restores raw mode and stops listening once the picker resolves", async () => {
    const input = fakeInput();
    const picker = new TtyPicker({ input, output: fakeOutput() });

    const resultPromise = picker.pick(ROWS);
    expect(input.rawMode).toBe(true);
    expect(input.listenerCount("keypress")).toBe(1);

    press(input, "escape");
    await resultPromise;

    expect(input.rawMode).toBe(false);
    expect(input.listenerCount("keypress")).toBe(0);
  });

  it("resolves undefined without drawing or listening when there are no rows", async () => {
    const input = fakeInput();
    const output = fakeOutput();
    const picker = new TtyPicker({ input, output });

    await expect(picker.pick([])).resolves.toBeUndefined();
    expect(output.chunks).toEqual([]);
    expect(input.listenerCount("keypress")).toBe(0);
  });
});
