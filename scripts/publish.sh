#!/usr/bin/env bash
# Build, validate, and publish copilot-tracer to npm.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo "=== copilot-tracer publish ==="

# 1. Clean previous build
echo "→ Cleaning dist/"
rm -rf dist/

# 2. Install deps
echo "→ Installing dependencies"
npm ci

# 3. Type-check
echo "→ Type-checking"
npx tsc --noEmit

# 4. Build
echo "→ Building"
npx tsc

# 5. Verify the binary entry point exists
if [[ ! -f dist/cli.js ]]; then
  echo "✗ dist/cli.js not found after build — aborting"
  exit 1
fi

# 6. Confirm the native module loads (better-sqlite3 often breaks on new Node)
echo "→ Verifying better-sqlite3 native module"
node -e "import('better-sqlite3').then(() => console.log('  better-sqlite3 OK'))" || {
  echo "✗ better-sqlite3 failed to load. Run: npm install better-sqlite3@latest"
  exit 1
}

# 7. Dry-run to show what will be published
echo "→ Files that will be published:"
npm pack --dry-run

# 8. Confirm before publishing
read -r -p "Publish to npm? [y/N] " confirm
if [[ "$confirm" != "y" && "$confirm" != "Y" ]]; then
  echo "Aborted."
  exit 0
fi

# 9. Publish (add --tag next for pre-release)
echo "→ Publishing"
npm publish --access public

echo ""
echo "✓ Published! Install with: npm install -g copilot-tracer"
