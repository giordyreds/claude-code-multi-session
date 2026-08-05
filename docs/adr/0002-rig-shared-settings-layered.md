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

- The rendered settings file is **generated, not authored**. It carries a generated-by
  header, and hand-edits are detected and refused rather than silently clobbered —
  otherwise layering decays into per-Profile copies by accident.
- A shared plugins directory is a shared *mutable cache*. Concurrent plugin installs from
  two Profiles can race. Accepted as a known risk for a single-user tool.
- History is per Profile, so a Profile cannot continue a conversation started under
  another. Deliberate: it matches the work/personal boundary the tool exists to enforce.
