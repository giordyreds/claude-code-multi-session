---
status: accepted
---

# Split cli.ts into four command modules

[Issue #57](https://github.com/giordyreds/claude-code-multi-session/issues/57) splits `cli.ts`
(1082 lines, 13 commands) and `test/cli.test.ts` (2314 lines) — the two largest, most frequently
touched files in the repo — into four modules grouped by behavior, not by literal domain noun:

- `commands/identity.ts` — whoami, login, reconcile, ls (identity reporting and resolution)
- `commands/profile.ts` — add, rm, sync (Profile lifecycle)
- `commands/shell.ts` — use, run, shell-init (Binding and execution)
- `commands/machine.ts` — setup, teardown, doctor (machine-wide wiring and health)

The issue itself flagged this as Speculative rather than Strong: a naive one-module-per-command
split would produce 13 shallow files, and the four-way grouping is a judgment call the review
recommended grilling before any code moved. That grilling surfaced the real problem — the
four-way grouping is fine, but several helpers inside today's `cli.ts` don't respect its
boundaries, and forcing each one into a single "owning" module would just relocate the shallow-
module problem into misplaced imports instead of solving it.

## The rule for cross-cutting helpers

Three helpers cross the proposed boundaries, and not in the same way:

- **`reportError`** — called by all 13 commands. No domain owner at all; it's a thin wrapper
  around `fs-utils.ts`'s `errorMessage`. **Moves into `fs-utils.ts`**, next to the function it
  wraps.
- **`resolveKnownProfile`** — called by `run` (shell), `reconcile` (identity), and `rm` (profile);
  `use` (also shell) inlines the same lookup a fourth way instead of calling it. Three of four
  groups need it and none of them owns it. **Moves into a new `commands/shared.ts`** — a home that
  exists specifically for command-layer helpers used by more than one command module, so a
  helper with no real domain owner doesn't get assigned a false one. `use`'s inlined duplicate is
  folded into this same shared helper as part of the move, rather than left as a second copy.
- **`formatLiveIdentity`** (with the `NOT_LOGGED_IN`/`UNKNOWN` constants it needs) — called by
  `ls` (identity) and by `pickAlias` (used only by `use`, shell). Unlike the two above, this one
  *does* have a real owner: it takes a bare `AuthStatus` and returns a string, no `CliDeps`
  involved — pure domain formatting that was simply living one layer too high, in `cli.ts`,
  instead of beside `formatIdentity` in `src/identity.ts`. **Pushed down into `src/identity.ts`**,
  the domain layer both `commands/identity.ts` and `commands/shell.ts` already depend on for
  `formatIdentity` — an ordinary downward dependency, not a sideways one between command modules.

Every other helper (`shellQuote`, `syncProfile`, `pickAlias` itself, `reportDriftAndUpdateRegistry`,
each command's own usage string) has exactly one caller and moves with it, unmodified.

**The general rule going forward:** a cross-cutting command helper either (a) is pure and
layer-appropriate for an existing domain module — push it down there — or (b) is command-layer
glue with no single domain owner — put it in `commands/shared.ts`. Never force a false single
owner on a helper just to keep a module's line count down.

## Supporting structure

`CliDeps`, the `Command` type, and `RunCliOptions` move out of `cli.ts` into a new `src/cli-deps.ts`
— the contract every command module and `cli.ts` itself sits below, rather than something `cli.ts`
owns and the command modules import back from. Each command module exports its own
`Record<string, Command>` map (`IDENTITY_COMMANDS`, `PROFILE_COMMANDS`, etc.); `cli.ts` composes
`COMMANDS` from the four and keeps only argv parsing, default-resolution, and dispatch. Adding a
command inside an existing group is now a one-file change instead of two.

`test/cli.test.ts` splits along its own existing per-command `describe` blocks into
`test/commands/{identity,profile,shell,machine}.test.ts`, plus `test/commands/shared.ts` for
fixtures used by more than one group's tests (`captureLines`, `fakeClaudePort`, and similar).
`test/cli.test.ts` keeps only the tests that belong to `cli.ts` itself: `--help`/`--version`,
unknown-command handling, the Windows guard, and `defaultShellRcPath`. `test/shell-integration.test.ts`
(the test that spawns the real built binary) is untouched by any of this.

## Considered options

- **Force a single domain owner for every helper regardless of fit** — e.g. put
  `resolveKnownProfile` in `profile.ts` because Profile is the entity it looks up. Rejected: two
  of its three callers would then import across command modules for no domain reason, which is
  the exact coupling this split is meant to remove.
- **Leave all shared helpers in `cli.ts`** as a de facto fifth, unbounded "misc" file. Rejected:
  it keeps `cli.ts` growing indefinitely and blurs the line between "dispatch" and "helpers that
  didn't fit anywhere," which is the ambiguity this ADR exists to resolve.
- **Naive one-module-per-command (13 files)** — the alternative the architecture review itself
  named and rejected as manufacturing shallow modules; not revisited here.

## Consequences

- Command modules end up with a strictly downward dependency graph: `cli-deps.ts`, the domain
  layer (`registry.ts`, `identity.ts`, `doctor.ts`, etc.), and `commands/shared.ts` — never each
  other.
- `commands/shared.ts` and the push-down into `src/identity.ts` look like two different fixes for
  the same symptom (a helper needed in more than one place). They are: one has a real domain home
  one layer down, the other doesn't have one anywhere. Future helpers that cross these boundaries
  should be sorted the same way, not merged into a single "shared stuff" convention.
- This issue was blocked on [#53](https://github.com/giordyreds/claude-code-multi-session/issues/53)
  ("Give the CLI one dependency interface"), now closed — the uniform `(args, deps)` signature
  this split assumes already exists in `cli.ts` today.
