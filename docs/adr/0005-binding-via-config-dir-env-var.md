---
status: accepted
---

# Binding is the `CLAUDE_CONFIG_DIR` environment variable; Alias is its directory's basename

`whoami`, and every future Binding-aware command, needs two things ADR-0001 left open: how a
shell is actually "pointed at" a Profile's config directory, and how to recover that Profile's
Alias once it is. We verified by probe (same method as ADR-0001/0003) that setting
`CLAUDE_CONFIG_DIR` to a fresh directory redirects `claude auth status` to a state file rooted
there — reporting logged-out for a brand-new directory — while the real Default install,
queried immediately after, was unaffected. This is undocumented behaviour, reverse-engineered
the same way as the rest of the isolation mechanism in ADR-0001, so it stays behind the same
kind of boundary: a single port.

**Every invocation of the `claude` executable goes through one `ClaudePort`.** It shells out to
`claude auth status --json` — the only currently-documented machine-readable identity shape —
and nothing in this project parses Claude Code's own state file directly. Tests fake the port;
none of them ever spawn the real binary.

**A Profile's Alias is its config directory's basename**, not a separately stored field. `ccp
whoami` resolves the bound directory from `CLAUDE_CONFIG_DIR` and reports its basename as the
Alias with no registry lookup involved.

## Considered Options

- **A registry file mapping Alias → directory path.** Rejected for now: no command yet creates,
  renames, or lists Profiles, so a registry would have nothing to record and nothing to keep in
  sync. Revisit the moment a command needs to store more about a Profile than its bare Alias —
  in particular, CONTEXT.md's **Expected identity**, which Drift detection needs and a directory
  name alone cannot carry.
- **Reading Claude Code's own state file directly to resolve identity.** Rejected: its format is
  undocumented and already known (ADR-0002 amendment 1) to be written by Claude Code itself at
  runtime. `auth status --json` is the stable, documented-enough surface Claude Code offers for
  exactly this question, and ADR-0001 already commits this project to delegating identity and
  credential concerns to `claude` rather than reverse-engineering its on-disk state.

## Consequences

- A future `bind` command sets `CLAUDE_CONFIG_DIR` in the *calling* shell. Per ADR-0004 that can
  only happen via the shell function evaluating our stdout — `bind` will print an `export`
  statement, never set the variable itself.
- The basename-as-Alias convention must carry forward unchanged once `create`/`list` commands
  exist, so `whoami` doesn't need to change under them. It breaks the day a Profile needs to
  carry data beyond its Alias (Expected identity, above) — that day forces the registry file
  this ADR defers, not a patch to this one.
- `claude auth status` creates a fresh `.claude.json` (plus a backup) the first time anything
  asks it about a directory that doesn't exist yet. A not-yet-created Alias is therefore
  indistinguishable, from the port's point of view, from an empty, logged-out Profile — worth
  remembering before a future "list all profiles" command trusts directory existence alone.
- Because the port is the only thing that ever shells out to `claude`, any future change to
  `auth status --json`'s shape is a one-file fix.
- **`claude auth status` exits `1` on a perfectly normal logged-out Profile** — verified by
  probe, not documented. The port must judge success by whether it got parseable, well-shaped
  JSON back, never by exit code, or every unauthenticated-but-otherwise-fine Profile would be
  reported as a hard error instead of the honest "not logged in" ADR-0001 already commits to.
