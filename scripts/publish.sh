#!/usr/bin/env bash
# Build, version-bump, validate, publish copilot-tracer to npm, and git-tag the release.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# ── Parse args ────────────────────────────────────────────────────────────────
# Usage: ./scripts/publish.sh [patch|minor|major|--tag <dist-tag>]
#   patch (default)  bump 1.0.0 → 1.0.1
#   minor            bump 1.0.0 → 1.1.0
#   major            bump 1.0.0 → 2.0.0
#   --tag beta       publish as beta without bumping version (e.g. 1.0.0-beta.0)
BUMP="patch"
DIST_TAG="latest"
PRE_ID=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    patch|minor|major) BUMP="$1"; shift ;;
    --tag) DIST_TAG="$2"; shift 2 ;;
    --pre) PRE_ID="$2"; shift 2 ;;   # e.g. --pre beta → 1.0.1-beta.0
    *) echo "Unknown arg: $1"; exit 1 ;;
  esac
done

echo ""
echo "╔════════════════════════════════════════════════╗"
echo "║       copilot-tracer  ·  npm publish           ║"
echo "╚════════════════════════════════════════════════╝"
echo ""

# ── 1. Check npm auth ─────────────────────────────────────────────────────────
echo "→ Checking npm authentication"
NPM_USER=$(npm whoami 2>/dev/null || true)
if [[ -z "$NPM_USER" ]]; then
  echo "✗ Not logged in to npm. Run: npm login"
  exit 1
fi
echo "  Logged in as: $NPM_USER"

# ── 2. Check git working tree is clean ────────────────────────────────────────
echo "→ Checking git status"
if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "✗ Uncommitted changes detected. Commit or stash before publishing."
  git status --short
  exit 1
fi
CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD)
echo "  Branch: $CURRENT_BRANCH"

# ── 3. Clean + install ────────────────────────────────────────────────────────
echo "→ Cleaning dist/"
rm -rf dist/

echo "→ Installing dependencies (ci)"
npm ci

# ── 4. Type-check ─────────────────────────────────────────────────────────────
echo "→ Type-checking"
npx tsc --noEmit

# ── 5. Build ──────────────────────────────────────────────────────────────────
echo "→ Building"
npx tsc

if [[ ! -f dist/cli.js ]]; then
  echo "✗ dist/cli.js not found after build — aborting"
  exit 1
fi

# ── 6. Verify native module ───────────────────────────────────────────────────
echo "→ Verifying better-sqlite3"
node -e "import('better-sqlite3').then(() => process.exit(0)).catch(() => process.exit(1))" || {
  echo "✗ better-sqlite3 failed to load."
  echo "  Fix: npm install better-sqlite3@latest && npx tsc"
  exit 1
}
echo "  better-sqlite3 OK"

# ── 7. Version bump ───────────────────────────────────────────────────────────
OLD_VERSION=$(node -p "require('./package.json').version")

if [[ -n "$PRE_ID" ]]; then
  npm version "pre${BUMP}" --preid="$PRE_ID" --no-git-tag-version
else
  npm version "$BUMP" --no-git-tag-version
fi

NEW_VERSION=$(node -p "require('./package.json').version")
echo "→ Version: $OLD_VERSION → $NEW_VERSION  (tag: $DIST_TAG)"

# ── 8. Pack dry-run ───────────────────────────────────────────────────────────
echo ""
echo "→ Files that will be published:"
npm pack --dry-run 2>&1 | grep -E '^\s*(npm notice files:|[0-9]+)' | head -30 || npm pack --dry-run
echo ""

# ── 9. Confirm ────────────────────────────────────────────────────────────────
read -r -p "Publish v${NEW_VERSION} to npm (tag: ${DIST_TAG})? [y/N] " confirm
if [[ "$confirm" != "y" && "$confirm" != "Y" ]]; then
  # Roll back version bump
  npm version "$OLD_VERSION" --no-git-tag-version --allow-same-version 2>/dev/null || true
  echo "Aborted — version rolled back to $OLD_VERSION"
  exit 0
fi

# ── 10. Publish ───────────────────────────────────────────────────────────────
echo "→ Publishing to npm"
npm publish --access public --tag "$DIST_TAG"

# ── 11. Git commit + tag ──────────────────────────────────────────────────────
echo "→ Committing version bump and tagging"
git add package.json
git commit -m "chore: release v${NEW_VERSION}"
git tag "v${NEW_VERSION}"

echo ""
echo "✓ Published v${NEW_VERSION} (tag: ${DIST_TAG})"
echo ""
echo "  Push the tag:    git push origin v${NEW_VERSION}"
echo "  Push the commit: git push"
echo "  Install:         npm install -g copilot-tracer"
if [[ "$DIST_TAG" != "latest" ]]; then
  echo "  Install (beta):  npm install -g copilot-tracer@${DIST_TAG}"
fi
echo ""
