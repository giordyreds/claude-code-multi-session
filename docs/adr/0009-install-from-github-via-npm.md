---
status: accepted
---

# `ccp` is installed from the GitHub repository via npm; nothing is published

The tool has to be handed to someone else, and until now the only way to get it was to clone,
install dependencies, build, put a compiled file on `PATH` by unspecified means, and hand-edit
`.zshrc` with a path that depends on where the clone landed. The installation channel was never
chosen — it was whatever the maintainer happened to do. This decision picks one.

**The channel is npm, installing directly from the GitHub repository.** The documented line is:

```sh
npm i -g github:giordyreds/claude-code-multi-session#semver:^1.0.0
```

Nothing is published to a package registry. `package.json` keeps `private: true` — verified
during design that this does not obstruct installation from a git reference, because `private`
blocks *publishing* only.

**The reference is a semver range resolved against release tags**, not a branch and not a fixed
tag. A branch would hand whoever installs today whatever happens to be on it, half-finished work
included. A fixed tag would put a version number in the README that goes stale on every release
and has to be edited. A range is permanent in documentation, reproducible in resolution, and
leaves an exact-tag pin (`#v1.2.0`) as the escape hatch for anyone who must stay on a
known-good version.

**Releases are tagged from the stable branch**, and the release ritual — bump the package
version, merge to the stable branch, tag, push — is written down rather than remembered. This
matters more than it looks: the documented install line resolves against tags, so a release that
is never tagged makes that line silently resolve to nothing useful, for everybody, with no error
that points at the cause.

## Considered Options

- **Publish to the npm registry.** Rejected. It buys a shorter install line and nothing else
  this tool needs — npm installs from a git reference just as well. In exchange it takes a
  permanent public name, an artifact that outlives interest in maintaining it, and the implicit
  support posture that publishing carries. This is a personal tool being handed to a colleague,
  not a product. The decision is reversible: moving to the registry later changes one line of
  the README and nothing about the tool.
- **A system package manager tap (e.g. a Homebrew formula).** Rejected. It means a second
  repository and a formula to update on every release, in order to distribute a Node program
  whose dependency resolution npm already performs — and whose users, by definition, already
  have Node, since `ccp` is a Node program. Strictly more machinery for strictly less than what
  npm already does.
- **A piped shell installer (`curl … | sh`).** Rejected, and worth recording why rather than
  leaving it to taste. It asks the user to execute an unreviewed script fetched over the network
  as the very first thing they do — from a tool whose stated promise is that it never mutates
  anything behind their back. It would also have to reimplement, badly, what npm already
  provides: version resolution, upgrade, and uninstall. The two-command flow does the same job
  while leaving the user a `Setup` step they can read first and undo afterwards.

## Consequences

- Installation needs `git` and network access to GitHub; a private repository additionally needs
  the installing user to be authenticated to it. This is acceptable for the intended audience
  and is the price of not publishing.
- **The package must explicitly declare the files it ships.** The build output directory is
  git-ignored, and npm falls back to the git ignore rules when no package-level ignore file
  exists — which strips the build output from the package and installs a `ccp` command that is a
  dangling symlink to a file that was never shipped. This is the current, verified state of the
  repository, not a hypothetical, and it is a blocking prerequisite for the install line above
  being true (issue #30).
- A supported Node version range is declared, so an unsupported runtime fails at install rather
  than mysteriously later.
- Consumers build from source at install time via a prepare step, so no build output is
  committed to the repository.
- Upgrading is re-running the same command; there is nothing new to learn. Pinning an exact tag
  is the supported way to stay put, and is the whole of this project's backward-compatibility
  mechanism (ADR-0010).
- Installing the package is deliberately *not* the whole of installation. It makes the command
  available; **Setup** makes it available to new shells, and is a separate explicit act
  (ADR-0004's amendment).
