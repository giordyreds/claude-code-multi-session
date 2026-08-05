# Spike 0001 — Does a fully assembled Profile work?

Resolves issue #1. Ran against Claude Code 2.1.221 on macOS, using a throwaway Profile
directory with the Rig shared from the Default install and a copy of the base settings.

**Verdict: ADR-0002's central claim is confirmed.** Sharing the Rig works, and plugin
enablement travels with the settings file exactly as predicted. Three findings amend the
ADR's *consequences*, one of which makes a stated design detail impossible as written.
One acceptance criterion could not be settled and remains open.

## Confirmed

| Claim | Result |
|---|---|
| Configuration directories follow symbolic links | Yes |
| Plugin *inventory* travels with the plugins directory | Yes — listed, but `✘ disabled` with no settings file |
| Plugin *enablement* travels with the settings file | Yes — `✔ enabled` once the settings copy is present |
| A Rig-only skill is visible to a Session under the Profile | Yes — both the user skill and plugin-provided skills listed |
| A Rig-only skill actually **loads and runs** | Yes — invoking `graphify` returned its instructions |
| The Default install is unaffected | Yes — identity, state file, base settings and plugin state all intact |

The enablement result is the one that mattered: it is why the settings file cannot simply
be omitted from a Profile, and therefore why layering (rather than sharing or copying)
is required.

## Open — could not be settled

**Whether the base settings' pinned model works on a Pro-tier Profile, or must be overridden.**

Both throwaway Profile directories now resolve to the Team Account. Backups show the
personal Pro Account was present at 09:42 and replaced by the Team Account by 09:43 the
same morning, and the Pro-era `modelAccessCache` was recorded empty — so the question
cannot be answered from disk. Settling it requires logging a Profile into the Pro Account
and observing whether the pinned model is granted.

This does not block the Rig work. It blocks only the *evidence* for the per-Profile
override being necessary; the override mechanism is required regardless, because the
settings file demonstrably carries entitlement-sensitive values.

## Amendments to ADR-0002

**1. The settings file has a second writer.** Claude Code writes to it at runtime — a
`"tui"` key appeared in the Profile's copy that is absent from the base. The write landed
on the Profile's own file, not through to the base, which is good news for isolation and
bad news for change detection: a rendered file that refuses hand-edits will trip on
Claude Code's own writes during ordinary use. Distinguishing "the tool's runtime write"
from "the user hand-edited this" is now a requirement, not a nicety.

**2. A generated-by *header* is impossible.** The file is strict JSON:

- A `//` comment line **breaks it silently** — no error, no warning, and the plugin
  reverted to `✘ disabled` because the settings simply failed to apply.
- An unknown top-level key (`"$generatedBy"`) is tolerated and persists across reads.

So the marker must be a key, never a comment. More importantly, the silent-failure mode
means a renderer cannot trust its own output: it must parse back what it wrote before
believing the render succeeded, because a malformed result produces no complaint at all —
just settings that quietly do not apply.

**3. The shared plugins directory is worse than a write race.** A Session under the
Profile wrote an orphan marker into the *shared* plugin cache, recording the cached plugin
as orphaned. Nothing broke — the Default install still reports the plugin enabled and its
skills still resolve, and the marker was removed afterwards — but this is a
garbage-collection marker, not a cache entry. A later cleanup pass acting on it would
delete plugin files out from under the Default install. The risk is cross-Profile state
corruption, not merely concurrent-install contention.

## Incidental findings

- **The Rig is smaller than assumed.** `agents/` and `commands/` do not exist in this
  Default install; only instructions, skills, plugins and hooks do. Skipping absent Rig
  items is load-bearing behaviour, not defensive coding.
- **Drift was observed in the wild.** A throwaway Profile changed Account underneath us
  within the same morning. Exactly the failure mode Drift detection exists to catch,
  observed before a line of it was written.
