---
status: accepted
---

# The Rig is shared, history is isolated, and settings are layered

Isolating a whole configuration directory per Profile isolates *everything* — a new Profile
starts with no instructions, skills, plugins or hooks, which would make Profiles
non-interchangeable and the tool unused by week two. So configuration is split three ways:
the Rig is shared by symlink, identity and history are genuinely isolated, and the settings
file is layered because it is the one file that is part-shared and part-Profile-specific.

| | mechanism | contents |
|---|---|---|
| **Rig** | shared, by symlink | instructions, skills, plugins, hooks, agents, commands |
| **Settings** | rendered from base + per-Profile override | the single settings file |
| **Identity and history** | isolated, real files | state file, project history, sessions, tasks, shell snapshots |

## Considered Options

Two facts forced the layering, and both are non-obvious enough to record:

- Plugin **inventory** lives in the plugins directory but plugin **enablement** lives in the
  settings file. Sharing the plugins directory without sharing settings yields plugins that
  are listed and disabled — verified by probe.
- The settings file also pins the model, and the model is entitlement-dependent, hence
  organization-dependent, hence Profile-dependent. Our own two Profiles differ (Team vs
  Pro), so one shared value cannot be correct for both.

Symlinking the settings file wholesale was rejected for that reason; copying it per Profile
was rejected because it drifts silently and you debug a hook that fires in one Profile
and not another.

## Consequences

- The rendered settings file is **generated, not authored**. It is marked as such with a
  reserved top-level key — *not* a comment header, which is impossible; see the amendments
  below. Unexpected changes are detected and refused rather than silently clobbered,
  otherwise layering decays into per-Profile copies by accident.
- A shared plugins directory is a shared *mutable cache*, and sharing it risks
  cross-Profile state corruption, not merely contention. Accepted as a known risk for a
  single-user tool, but see amendment 3.
- History is per Profile, so a Profile cannot continue a conversation started under
  another. Deliberate: it matches the work/personal boundary the tool exists to enforce.

## Confirmed, and amended, by spike

The central claim was verified against a real assembled Profile — see
[Spike 0001](../spikes/0001-assembled-profile.md), resolving issue #1. Configuration
directories follow symbolic links; plugin inventory travels with the plugins directory
while enablement travels with the settings file; and a skill living only in the shared Rig
both resolves and runs under an isolated Profile. The Default install was unaffected.

Three findings amend the consequences above, and any work on the Rig or the renderer must
respect them:

1. **The settings file has a second writer.** Claude Code writes to it at runtime. Change
   detection must therefore distinguish the tool's own runtime writes from a genuine
   hand-edit, or it will refuse to re-render during ordinary use.
2. **A generated-by header is impossible, and malformed output fails silently.** The file
   is strict JSON: a comment line breaks it with no error at all, leaving settings quietly
   unapplied, while an unknown top-level key is tolerated and persists. The marker must be
   a key, and the renderer must parse back its own output rather than assume success.
3. **The shared plugin cache can be marked orphaned by a Profile Session.** That is a
   garbage-collection marker, so a later cleanup could delete plugin files out from under
   the Default install. This escalates the shared-cache risk from a race to potential
   cross-Profile corruption.

One question the spike could not settle: whether the base settings' pinned model is granted
on a Pro-tier Profile or must be overridden. It needs a Pro Login to answer. The override
mechanism is required either way, because the settings file demonstrably carries
entitlement-sensitive values.
