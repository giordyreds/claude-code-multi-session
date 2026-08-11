---
status: accepted
---

# Binding is a shell function, so there is no full-screen interface

The tool is a command-line program driven through a shell function, and the only
interactive surface is a picker for when no alias is given. This looks like a missed
opportunity for a full-screen interface, so the reason is recorded here: **a child process
cannot modify its parent shell's environment.** Since a Profile is a property of a shell,
binding *must* be performed by a shell function evaluating output from the program. A
full-screen interface could therefore only ever *select* a Profile and print it for the
parent to evaluate — it can never do the switching itself.

## Consequences

- The binding command must print **only** shell-evaluable output on stdout. Every warning,
  drift notice and picker frame goes to stderr. Getting this wrong once means a friendly
  warning is evaluated as code and breaks the user's shell.
- The program is unavailable under its own name in non-interactive shells, since the name
  belongs to the shell function. Scripts use the run subcommand instead.
- A full-screen interface remains justifiable for a *different* product — supervising many
  live sessions across Profiles. That is not this tool, and building it before feeling the
  need would spend the budget on chrome instead of on identity isolation.

## Amendment 1: the shell function is emitted by the tool, not sourced from a path (#32)

Everything above stands unchanged. A child process still cannot modify its parent shell's
environment, Binding is still performed by a shell function evaluating this program's stdout, and
that is still why there is no full-screen interface. What changes is only how the function
*reaches* the shell.

Until now, `.zshrc` sourced `shell/ccp.sh` by absolute path. That path depends on where the
package happens to live, which for anyone managing Node with a version manager is scoped per Node
version: upgrade Node, and the path silently ceases to exist, `source` fails at shell start, and
the `ccp` shell function is never defined. Binding then *appears* to work — `ccp use` prints its
export line and exits zero — while the shell is never bound at all. That is precisely the failure
this ADR exists to prevent, reintroduced by the installation instructions.

**A new command emits the shell function on stdout, and the `.zshrc` line evaluates that output**
rather than sourcing a file. The same line works on every machine and survives Node upgrades,
because nothing in it names a path. The line is guarded on the command's presence, so removing the
package leaves a harmless no-op instead of an error on every shell start. **`shell/ccp.sh` remains
the single source of truth**; the emit command reads and prints it, so the file and the emitted
text cannot drift apart, and the existing tests that source the file directly keep working
unchanged.

The consequence recorded above — that the binding command must print **only** shell-evaluable
output on stdout, with every warning and picker frame on stderr — now binds a second command. The
emit command's output is evaluated too, at the start of every interactive shell, so the same
stdout discipline applies to it exactly as it applies to Binding.

Adding the line is **Setup** (CONTEXT.md), a separate explicit act rather than something the
package installation does on the user's behalf.
