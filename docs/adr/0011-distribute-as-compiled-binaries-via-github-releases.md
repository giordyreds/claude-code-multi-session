---
status: accepted
supersedes: 0009-install-from-github-via-npm.md
---

# `ccp` ships as a standalone compiled binary attached to GitHub Releases, not an npm install

ADR-0009 chose `npm i -g github:giordyreds/claude-code-multi-session#semver:^1.0.0` as the one
documented way to get `ccp`, on the premise that "consumers build from source at install time via
a prepare step, so no build output is committed to the repository." That premise is false against
current tooling, verified rather than suspected:

- A plain `cd <clone> && npm install --include=dev` builds `ccp` successfully every time, at any
  commit, with or without a stale `package-lock.json`.
- The same repository, installed the documented way (`npm i -g github:...`, and equivalently
  `npm i -g git+file://...`), fails every time with `sh: tsc: command not found`.
- Moving `typescript` and `@types/node` from `devDependencies` to `dependencies` and repeating the
  global install does not fix it — it fails identically. This rules out a dependency-category
  mistake in `package.json`.
- npm's own debug log for the failing case shows why: the internal "git dep preparation" install
  that pacote runs before invoking the `prepare` script places the package itself into the tree
  and installs *nothing else* — not dev, not production — despite the exact same invocation, run
  by hand in the exact same directory, resolving dependencies correctly.

This is a defect in npm's global git-dependency install path (npm 11.17.0, Node v26.5.0), not
something `package.json` can route around. ADR-0009's mechanism cannot be fixed from inside this
repository.

**`ccp` now ships as a standalone executable — the JavaScript runtime compiled in — attached to
GitHub Releases**, built with `bun build --compile` from `src/bin.ts`. Installing it is
downloading a file and putting it on `PATH`; nothing is built, and nothing is installed, on the
machine that runs it. This mirrors the release pipeline already in production use for
`parallel-issue-solver` (`scripts/build-binaries.sh`, `.github/workflows/release.yml`) — a sibling
personal tool by the same maintainer, solving the identical problem: git-only distribution with no
package registry.

The release pipeline builds all seven of `bun build --compile`'s targets (macOS, Linux, and
Windows, across architectures and libc variants), even though `ccp` itself only functions on
macOS + zsh today — `setup.ts` writes to `.zshrc`, and several Checks branch on
`process.platform === "darwin"`. This is deliberate, not an oversight: it costs nothing extra in
CI, and it means a future decision to support another platform is a `src/` change alone, with the
release pipeline already in place to publish it. The non-macOS binaries simply have nothing to
install onto right now, and the README says so.

## Considered Options

- **Fix the npm install path.** Rejected — not a design choice but a dead end, per the
  verification above. The failure originates inside npm's own git-dependency handling, which this
  project does not control and cannot patch around by rearranging `package.json`.
- **Publish to the npm registry.** Rejected for the same reasons ADR-0009 already gave: a
  permanent public name and support posture this personal tool doesn't want, in exchange for
  nothing `ccp` actually needs. Registry tarballs are pre-built at publish time and would sidestep
  the broken path, but so does shipping binaries directly, without the registry's other costs.
- **A system package manager tap (e.g. Homebrew).** Rejected for the same reasons ADR-0009 already
  gave — a second repository and formula to maintain on every release, for strictly less than a
  GitHub Release asset already provides.
- **Build for macOS only**, matching what `ccp` actually supports. Considered directly and
  rejected: the full matrix costs nothing extra to build and removes a step from ever adding
  another platform later.

## Consequences

- **Two runtime file reads had to become compile-time embeds.** `src/version.ts` read
  `package.json` for `ccp`'s version, and `src/shell-init.ts` read `shell/ccp.sh` for the shell
  function text — both assuming a sibling file exists next to the running code. A standalone
  compiled binary has no such sibling; both now check a `declare const` identifier
  (`BUILD_VERSION`, `EMBEDDED_SHELL_INIT_SCRIPT`) that `bun build --define` stamps in at compile
  time, falling back to the original file read when the identifier is undeclared — which is what a
  plain `tsc` build and every existing test still exercise unchanged.
- **`scripts/require-supported-node.mjs` no longer guards installation.** Nothing about the Node
  running on an end user's machine matters anymore — they run a compiled binary, not `ccp`'s
  source. The gate still guards *building* `ccp`, so it stays in `npm run build`, just without the
  `prepare` lifecycle hook that used to invoke it at npm-install time (that hook is gone along with
  the install path it served).
- **`test/packaging.test.ts` is gone.** It asserted on `npm pack --dry-run`'s output — which files
  end up in the tarball, whether `prepare` still ran — none of which describes anything real once
  nothing is installed via npm. Its Node-version-gate tests, which guard something that still
  exists, moved to `test/require-supported-node.test.ts`.
- **The release ritual (README) gains a consequence, not a step.** Bumping the version, merging to
  `main`, tagging, and pushing is unchanged from ADR-0009 — but pushing the tag now triggers
  `.github/workflows/release.yml` to build and publish the binaries. A release that's never tagged
  now means nothing was built or published, not merely that the install line resolves to stale
  code.
- **`ccp doctor` and `ccp setup` still run the same Checks** — nothing about *how they're
  installed* changes what they verify at runtime.
- ADR-0010's compatibility mechanism (pin an exact release) is unaffected: pinning is downloading
  an older tag's asset instead of the newest one, in place of installing an older git tag.
