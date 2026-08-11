# Claude Code Multi-Session

Lets one machine hold several Claude Code identities at once, so separate shells can run
under separate accounts simultaneously without logging in and out.

## Language

### Identity

**Profile**:
A named, isolated Claude Code identity on this machine — the unit you switch between.
Resolves to exactly one (Account, Organization) pair.
_Avoid_: account, environment, workspace, context

**Alias**:
The short user-chosen name that uniquely identifies a Profile. The primary key you type.
_Avoid_: name, id, label

**Account**:
The Anthropic-side login, identified by email address. Owned by Anthropic, not by us.
_Avoid_: user, login, identity

**Organization**:
The Anthropic-side org a Profile bills and rate-limits against. Determines entitlements
such as seat tier and available models. One Account may hold seats in several.
_Avoid_: team, org unit, workspace, tenant

**Expected identity**:
The (Account, Organization) pair a Profile is recorded as resolving to. An expectation,
never an authority — see Drift.
_Avoid_: actual identity, true identity

### Machine state

**Rig**:
The identity-neutral configuration shared across all Profiles — instructions, skills,
plugins, hooks, agents, commands. Changes what you *can do*, never *who you are*.
_Avoid_: config, setup, dotfiles, base

**Default install**:
The Claude Code configuration used when no Profile is bound. Unmanaged: this project
never migrates or mutates it, and it is the source of the Rig.
_Avoid_: system profile, global profile, root profile, fallback

**Session**:
One running Claude Code process, operating under exactly one Profile.
_Avoid_: instance, process, run

### Operations

**Binding**:
Pointing a shell at a Profile, so commands run in that shell adopt its identity.
A shell property, not a machine property; several shells may be bound differently at once.
_Avoid_: switching, activating, selecting, using

**Login**:
Authenticating a Profile against Anthropic. Happens once per Profile and is always
explicit, because it opens a browser. Distinct from Binding — a Profile can be
bound but not logged in.
_Avoid_: auth, signin, connect

**Drift**:
The state where a Profile's observed identity no longer matches its expected identity —
typically because someone logged in directly while a shell was bound to it.
_Avoid_: mismatch, desync, stale

**Reconciliation**:
Resolving Drift by accepting the observed identity as truth and updating the expected
identity to match.
_Avoid_: repair, fix, heal, sync

**Setup**:
The one-time act of making this tool available to new shells — adding the `ccp` shell
function to the shell startup file, then verifying the machine can run the tool. Distinct
from Default install, which is Claude Code's own configuration and is neither created nor
managed here: Setup wires up `ccp`, never Claude Code. Also distinct from *installing the
binary*, the earlier and separate act of putting the `ccp` command on `PATH` — that word
stays free for whatever does that, and never names this.
_Avoid_: install, installation, bootstrap, provisioning, init

### Dependence on Claude Code

**Contract**:
A behaviour of Claude Code that this tool depends on and does not control — the shape of
its machine-readable identity output, the existence of a subcommand, the isolation its
config-directory variable actually provides. Anthropic never documented these and owes us
nothing, so a Contract is verified by observation and never assumed from a version number.
_Avoid_: API, interface, dependency, assumption, guarantee

**Check**:
A runtime verification that a Contract still holds, reported by name alongside what it
found. A Check reports; it never repairs — repair is Reconciliation and `ccp sync`. Not to
be confused with a *probe*, which throughout this repository's decision records means a
manual experiment run during design, not something the tool performs.
_Avoid_: probe, test, validation, health check, diagnostic
