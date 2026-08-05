import { emitKeypressEvents } from "node:readline";

/** One selectable row in the picker — a Profile's Alias, and the line rendered for it. */
export interface PickerRow {
  alias: string;
  label: string;
}

/** The subset of a keypress event {@link TtyPicker} reacts to (mirrors `readline`'s own `Key`). */
export interface PickerKey {
  name?: string;
  ctrl?: boolean;
}

/** The subset of `NodeJS.ReadStream` {@link TtyPicker} needs — narrow enough that tests can fake
 * a terminal without spawning a real one. `process.stdin` satisfies this as-is. */
export interface PickerInput {
  readonly isTTY?: boolean;
  on(event: "keypress", listener: (str: string | undefined, key: PickerKey) => void): void;
  removeListener(event: "keypress", listener: (str: string | undefined, key: PickerKey) => void): void;
  setRawMode?(mode: boolean): void;
  resume(): void;
  pause(): void;
}

/** The subset of `NodeJS.WriteStream` {@link TtyPicker} needs. `process.stderr` satisfies this
 * as-is. Per ADR-0004, the picker frame must only ever reach this stream, never stdout. */
export interface PickerOutput {
  write(chunk: string): void;
}

/**
 * Presents `rows` for interactive selection, so `ccp use` with no Alias (see ticket #9) has
 * somewhere to send them. Real callers use {@link TtyPicker}; tests fake this interface directly,
 * the same seam shape as {@link ClaudePort} (src/claude-port.ts).
 */
export interface Picker {
  /** Resolves the selected row's Alias, or `undefined` if the user cancelled — Esc, Ctrl+C, or
   * 'q'. Rejects, without drawing anything, if there is no interactive terminal to draw on. */
  pick(rows: PickerRow[]): Promise<string | undefined>;
}

const CANCEL_KEYS = new Set(["escape", "q"]);

export interface TtyPickerOptions {
  /** Test seam: replaces `process.stdin`. */
  input?: PickerInput;
  /** Test seam: replaces `process.stderr`. */
  output?: PickerOutput;
}

/**
 * Real {@link Picker}: draws a arrow-key-navigable list on stderr and reads raw keypresses from
 * stdin. Built on nothing but `node:readline`'s keypress parsing — no TUI dependency — per
 * ADR-0004's own instruction not to spend the budget on chrome beyond exactly this picker.
 */
export class TtyPicker implements Picker {
  private readonly input: PickerInput;
  private readonly output: PickerOutput;

  constructor(options: TtyPickerOptions = {}) {
    this.input = options.input ?? (process.stdin as unknown as PickerInput);
    this.output = options.output ?? process.stderr;
  }

  async pick(rows: PickerRow[]): Promise<string | undefined> {
    if (!this.input.isTTY) {
      throw new Error(
        "ccp use with no Alias needs an interactive terminal for its picker. Pass an Alias directly: ccp use <alias>.",
      );
    }
    if (rows.length === 0) {
      return undefined;
    }

    const { input, output } = this;

    return new Promise((resolve) => {
      let index = 0;
      let drawn = false;

      const render = () => {
        if (drawn) output.write(`\x1b[${rows.length}A`);
        drawn = true;
        for (const [i, row] of rows.entries()) {
          const prefix = i === index ? "> " : "  ";
          output.write(`\x1b[2K${prefix}${row.label}\n`);
        }
      };

      const finish = (result: string | undefined) => {
        input.removeListener("keypress", onKeypress);
        input.setRawMode?.(false);
        input.pause();
        resolve(result);
      };

      function onKeypress(_str: string | undefined, key: PickerKey): void {
        const name = key.name ?? "";
        if (name === "up") {
          index = (index - 1 + rows.length) % rows.length;
          render();
        } else if (name === "down") {
          index = (index + 1) % rows.length;
          render();
        } else if (name === "return") {
          finish(rows[index]?.alias);
        } else if (CANCEL_KEYS.has(name) || (name === "c" && key.ctrl)) {
          finish(undefined);
        }
      }

      emitKeypressEvents(input as unknown as NodeJS.ReadStream);
      input.setRawMode?.(true);
      input.resume();
      input.on("keypress", onKeypress);
      render();
    });
  }
}
