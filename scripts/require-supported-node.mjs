/**
 * Refuses to build on a Node older than the range `package.json` declares.
 *
 * Per ADR-0011, `ccp` ships as a standalone compiled binary — the end user installing a release
 * needs no Node at all, so this gate no longer guards installation (that was ADR-0009's model;
 * `engines` alone never enforced it, since npm treats a mismatch as a warning unless the
 * *installing* user has turned `engine-strict` on). What it still guards is *building* `ccp` from
 * source — contributors and the release pipeline both run `npm run build`, and this is what makes
 * an unsupported Node fail that step outright rather than produce a broken build silently.
 *
 * This is deliberately not a **Check** in CONTEXT.md's sense: it verifies nothing about Claude
 * Code, runs at build time rather than at runtime, and refuses rather than reports.
 *
 * The floor is read from `engines.node` rather than repeated here, so there is one place to change
 * it. `>=X`, `>=X.Y` and `>=X.Y.Z` are understood — the forms a maintainer would plausibly write;
 * anything else stops the build with an explanation, since silently skipping the gate is how a
 * guard rots.
 *
 * Takes the version to judge as an optional argument (defaulting to the running Node) purely so
 * the packaging test can exercise the refusing path without a second Node installed.
 */
import { readFileSync } from "node:fs";

const manifestUrl = new URL("../package.json", import.meta.url);
const manifest = JSON.parse(readFileSync(manifestUrl, "utf8"));
const range = manifest.engines?.node;

const declaredRange = /^>=(\d+)(?:\.(\d+))?(?:\.(\d+))?$/.exec(range ?? "");
if (!declaredRange) {
  console.error(`package.json must declare engines.node as ">=X", ">=X.Y" or ">=X.Y.Z" for this gate to run; found ${JSON.stringify(range)}`);
  process.exit(1);
}

const candidate = process.argv[2] ?? process.versions.node;
const foundVersion = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(candidate);
if (!foundVersion) {
  console.error(`Cannot read a Node version out of ${JSON.stringify(candidate)}`);
  process.exit(1);
}

/** Major, minor, patch — an absent part reads as 0, so `>=22` means `>=22.0.0`. */
const asNumbers = (match) => match.slice(1, 4).map((part) => Number(part ?? 0));
const floor = asNumbers(declaredRange);
const actual = asNumbers(foundVersion);

/** Major first, then minor, then patch: the first difference decides. */
function isAtLeast(version, minimum) {
  for (const [index, part] of minimum.entries()) {
    if (version[index] > part) return true;
    if (version[index] < part) return false;
  }
  return true;
}

if (!isAtLeast(actual, floor)) {
  console.error(`ccp needs Node ${range}, but this is Node ${candidate}. Install a supported Node and run the install again.`);
  process.exit(1);
}
