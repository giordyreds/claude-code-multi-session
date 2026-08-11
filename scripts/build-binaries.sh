#!/usr/bin/env bash
#
# Compiles standalone `ccp` executables for every supported platform via `bun build --compile`,
# then archives them and writes a SHA256SUMS manifest.
#
# Both `npm run build:binaries` and .github/workflows/release.yml call this same script, so a
# release can be reproduced on a laptop rather than only inside CI.
#
# Usage: scripts/build-binaries.sh [version]   (defaults to the version in package.json)

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="$ROOT/bin-dist"
VERSION="${1:-$(node -p "require('$ROOT/package.json').version")}"
VERSION="${VERSION#v}"

# `bun build --target` value : the os-arch slug used in the published asset name.
TARGETS=(
  "bun-darwin-arm64:darwin-arm64"
  "bun-darwin-x64:darwin-x64"
  "bun-linux-x64:linux-x64"
  "bun-linux-arm64:linux-arm64"
  "bun-linux-x64-musl:linux-x64-musl"
  "bun-linux-arm64-musl:linux-arm64-musl"
  "bun-windows-x64:windows-x64"
)

rm -rf "$OUT"
mkdir -p "$OUT"
cd "$ROOT"

# `shell/ccp.sh` has no path to be read from once compiled into a standalone binary (see
# src/shell-init.ts, ADR-0011), so its exact contents are embedded as a source-code string
# literal via `--define` instead. JSON string-escaping is a valid subset of JS string-escaping,
# so `JSON.stringify` doubles as the literal-safe encoder here.
SHELL_INIT_JSON="$(node -p "JSON.stringify(require('fs').readFileSync('$ROOT/shell/ccp.sh', 'utf8'))")"

for entry in "${TARGETS[@]}"; do
  target="${entry%%:*}"
  slug="${entry##*:}"
  stage="$OUT/stage/$slug"
  mkdir -p "$stage"

  # Windows executables need the .exe suffix; bun appends it automatically, so name it
  # explicitly here to keep the archive step's paths predictable.
  if [[ "$slug" == windows-* ]]; then
    binary="$stage/ccp.exe"
  else
    binary="$stage/ccp"
  fi

  echo "==> $target"
  # --define stamps the version (src/version.ts) and the shell function text (src/shell-init.ts)
  # into the bundle, since a downloaded binary has neither package.json nor shell/ccp.sh to read
  # at runtime.
  bun build --compile --minify --bytecode \
    --define "BUILD_VERSION=\"$VERSION\"" \
    --define "EMBEDDED_SHELL_INIT_SCRIPT=$SHELL_INIT_JSON" \
    --target="$target" ./src/bin.ts --outfile "$binary"

  archive="ccp-${VERSION}-${slug}"
  if [[ "$slug" == windows-* ]]; then
    (cd "$stage" && zip -q "$OUT/${archive}.zip" "ccp.exe")
  else
    chmod +x "$binary"
    tar -czf "$OUT/${archive}.tar.gz" -C "$stage" "ccp"
  fi
done

rm -rf "$OUT/stage"

# `shasum` on macOS, `sha256sum` on most Linux images — support whichever is present so the
# manifest is identical either way.
cd "$OUT"
if command -v sha256sum >/dev/null 2>&1; then
  sha256sum ./*.tar.gz ./*.zip > SHA256SUMS
else
  shasum -a 256 ./*.tar.gz ./*.zip > SHA256SUMS
fi

echo
echo "Built ccp $VERSION into $OUT:"
ls -lh "$OUT"
