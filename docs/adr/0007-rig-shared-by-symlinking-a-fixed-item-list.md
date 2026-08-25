---
status: accepted
---

# The Rig is shared by symlinking a fixed item list from a reverse-engineered Default install path

ADR-0002 decided the Rig is shared by symlink; this decision fills in the two things it left
open — *where* the Default install lives on disk, and *which* items under it count as the Rig
— now that issue #6 needs code, not just a claim, and Spike 0001 has already verified the
central claim end to end.

**The Default install's configuration directory is `~/.claude`.** Nothing in this project has
ever needed its literal path before now: ADR-0001 and ADR-0005 delegate identity entirely to the
`claude` executable and never read its state file directly. Sharing the Rig is different in
kind — it requires listing and symlinking real paths under the Default install — so this is the
first place that path is written down. Like the rest of this project's identity-resolution
assumptions, it is reverse-engineered rather than documented by Anthropic. It follows the same
convention as the tool's own state directory: `defaultInstallDir()` stays a private helper in
`src/cli.ts`, next to the pre-existing `defaultStateDir()`, rather than living in `src/rig.ts` —
`rig.ts` takes `installDir` as an explicit parameter, same as `registry.ts` takes `stateDir`,
so every ambient default is resolved once, in one place, and every other module stays a pure
function of its inputs.

**The Rig is a fixed list of six path segments**, matching CONTEXT.md's definition exactly:
`CLAUDE.md` (instructions), `skills`, `plugins`, `hooks`, `agents`, `commands`. `repairRig`
symlinks whichever of these exist directly under the Default install into a new Profile's
config directory, one symlink per item, and skips any that don't exist — no error, no empty
directory fabricated in its place. Spike 0001 found `agents` and `commands` absent from a real
Default install, so this is ordinary behaviour a fresh installation will actually exercise, not
a defensive-coding nicety.

Only these six items are ever linked. Everything else that can live in a config directory — the
state file, `projects/`, `shell-snapshots/`, `sessions/`, `.credentials.json`, and the rendered
settings file layering will eventually produce — is left alone: a Profile's own directory holds
real files for all of it, never a symlink. Isolation is therefore a consequence of the item list
being fixed and short, not of any separate isolation logic.

## Considered Options

- **Copy the Rig into each Profile instead of symlinking.** Rejected: ADR-0002 already rejected
  this for the settings file (drifts silently) and the same argument applies harder here — a
  copied skill or plugin directory would need to be re-synced by hand every time the Default
  install changes, defeating "shared, not copied" outright.
- **Symlink the whole config directory.** Rejected: this is the option ADR-0002 opened by
  rejecting ("isolating a whole configuration directory per Profile isolates *everything*") run
  in reverse — symlinking the whole directory shares *everything*, including the state file and
  project history, which breaks Identity and history staying isolated per Profile. A fixed item
  list is what makes selective sharing possible at all.
- **Discover Rig items dynamically (whatever exists under a known set of names, plus anything
  else).** Rejected for now: CONTEXT.md's Rig is a closed, named list, not "whatever the Default
  install happens to contain." A dynamic scan would risk sharing something identity- or
  history-shaped that a future Claude Code version adds under a new top-level name.

## Consequences

- `addProfile` (`src/registry.ts`) takes `installDir` as a required parameter and calls
  `repairRig` right after creating the new Profile's config directory, before registering it in
  the registry. Every path that creates a Profile — `ccp add`, and `ccp login` auto-provisioning
  one on the spot — shares the Rig identically, since both go through `addProfile`.
- `runCli` (`src/cli.ts`) resolves `installDir` the same way it already resolves `stateDir`:
  an injectable option defaulting to the real path (`defaultInstallDir()`), so tests supply an
  isolated temporary directory instead of touching the real `~/.claude`.
- **The shared plugin cache's concurrent-install race is documented, not solved, by this
  decision.** ADR-0002 already recorded it as a known risk and, after Spike 0001, escalated it
  from a contention race to a potential cross-Profile corruption risk (its amendment 3): a
  Session under a Profile can write an orphan marker into the *shared* plugins directory, and a
  later garbage-collection pass acting on that marker could delete plugin files out from under
  the Default install. Nothing in this change adds locking, coordination, or a separate cache
  per Profile — doing so is out of scope for a single-user tool, and the risk is accepted exactly
  as ADR-0002 already accepted it. This decision only symlinks the `plugins` directory into place;
  it does not change how Claude Code itself reads or writes inside it.
- **Whether a Session under a Profile leaves that marker behind after exiting, and whether the
  Default install's plugin state survives, is already answered — by Spike 0001, not by this
  code.** The spike found the orphan marker was written and then removed, and the Default
  install's plugin state was intact afterwards. That evidence is what closes this acceptance
  criterion; no test in this change re-verifies it; doing so would mean scripting a real `claude`
  session against a real plugin cache, which is exactly what the spike already did once.
- Settings-file layering (ADR-0002's third row) is explicitly out of scope here: the Rig table
  and the Settings row are two different mechanisms in ADR-0002 for a reason, and this decision
  only implements the Rig row.

## Amendment: `shareRig` is deleted; `addProfile` calls `repairRig` directly (#54)

`shareRig` forwarded to `repairRig` and discarded its return value — a pure pass-through with no
behaviour of its own once `repairRig` existed to serve `ccp sync`. `addProfile` now calls
`repairRig` directly, as reflected above. Nothing about the decision this ADR records — a fixed
six-item list, symlinked, skipping whatever's absent — changes; only the identifier does.
