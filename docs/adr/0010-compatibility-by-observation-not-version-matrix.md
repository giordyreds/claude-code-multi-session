---
status: accepted
---

# Compatibility with Claude Code is verified by observation, not published as a version matrix

Every identity-resolution assumption in this project is reverse-engineered rather than documented
by Anthropic — ADR-0001, ADR-0005 and `0007-rig-shared-by-symlinking-a-fixed-item-list` each say
so about their own corner of it. CONTEXT.md now has a word for such an assumption: a **Contract**,
a behaviour of Claude Code that this tool depends on and does not control. Six are named (PRD
#28):

1. the shape of the machine-readable identity output;
2. the existence of the login subcommand;
3. the config-directory variable genuinely isolating an entire installation;
4. the location and field names of the onboarding state file;
5. the set of items that make up the Rig;
6. the settings file's schema.

**Three of those — 3, 4 and 5 — fail *silently*** if they change: a shell can quietly stop being
isolated, onboarding pre-seeding can quietly stop working, a Profile can quietly stop sharing the
Rig. The user finds out from a bill, or from work context surfacing in a personal Session — always
afterwards.

The obvious response is to publish which versions of `ccp` work with which versions of Claude
Code. This decision rejects that.

**There is one version line of `ccp`, always current, that Checks what it is talking to and
degrades honestly when something has moved.** Compatibility is established by running a **Check**
— a runtime verification that a Contract still holds — not by consulting a table. `ccp doctor`
runs the Checks, names each Contract with what it found, reports the Claude Code version it saw,
and records it, so the tool can state which version its Checks last passed against *on this
machine*. That record is the honest replacement for a matrix: an account of what was actually
verified here, rather than a table of combinations nobody ran.

**`ccp`'s own version number describes `ccp`'s own surface** — its commands, its state layout,
its emitted shell line — and says nothing about Claude Code compatibility. A major bump means
`ccp` changed under the user, not that Claude Code did.

## Considered Options

- **Publish a compatibility matrix of `ccp` versions against Claude Code versions.** Rejected on
  two independent grounds, either sufficient. First, it would assert combinations that were never
  tested: nobody is going to run every `ccp` release against every Claude Code release, so most
  cells would be inference presented as fact, and the ones that mattered would be the untested
  ones. Second, and worse, it cannot help with the failures that most need help. Three of the six
  Contracts fail silently — a user whose Profiles quietly stopped being isolated sees no error,
  and a user who sees no error never thinks to consult a table. A matrix is a document you reach
  for once you already suspect a problem; the whole difficulty here is not suspecting one.
- **Pin a supported Claude Code version range and refuse to run outside it.** Rejected: version
  numbers are not the signal. A release inside the declared range can change a Contract and a
  release outside it can leave every Contract intact, so this both blocks combinations that work
  and permits combinations that don't. It converts a real behavioural question into a proxy that
  answers it wrongly in both directions.
- **Maintain a branch or version line per Claude Code version.** Rejected: it multiplies the
  maintenance of a personal tool by the release cadence of somebody else's product, and pinning
  an exact `ccp` release tag (ADR-0009) already gives anyone who needs stability what a parallel
  line would have given them, at no maintenance cost.
- **Say nothing about compatibility at all**, as today. Rejected: this is the status quo, and it
  is exactly the problem. There is no way to answer "is it me or is it the tool?" without
  guesswork, and no way to learn that Claude Code moved except by being harmed by it.

## Consequences

- The isolation Check is behavioural, not version-based: it resolves each Profile's observed
  identity and compares it against Expected identity. It is the only Check that catches this
  tool's worst failure — a Session running under an identity the user did not choose — and it
  works whether or not anyone predicted the change that caused it. It must judge against Expected
  identity rather than mere sameness, so two Profiles legitimately sharing an Account are not
  falsely reported.
- Checks that cost a process spawn live only in `ccp doctor` and never on the Binding hot path.
  Binding already spawns `claude` once; it will not spawn a second time to read a version that
  changes a few times a year.
- Reading the Claude Code version is a new method on the existing port through which every
  invocation of the `claude` executable already goes (ADR-0005) — no new port, and no direct
  process spawning introduced elsewhere.
- When a Contract that already fails loudly does fail — the identity output no longer parsing is
  the live example — the error message must name the possibility that Claude Code has changed and
  point at `ccp doctor`, rather than surfacing as an opaque parse failure.
- `ccp doctor` reports and never repairs; repair stays with `ccp sync`. This is written into
  CONTEXT.md's definition of Check, so the distinction survives in the vocabulary and not just
  here.
- The README makes no compatibility claims. The supported way to stay on a known-good combination
  is to pin an exact release tag (ADR-0009), and that is the entire mechanism.
- A Contract that changes in a way no existing Check covers is still, honestly, a way this tool
  can break silently. This decision does not claim otherwise — it claims only that a matrix would
  not have caught it either, and that adding a Check is the response.
