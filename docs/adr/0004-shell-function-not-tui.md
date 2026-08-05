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
