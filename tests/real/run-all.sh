#!/usr/bin/env bash
# Lance les 3 suites de tests cork-ai
# Suite 1 : vitest (stats coherence)
# Suite 2 : benchmark sessions Claude Code réalistes
# Suite 3 : préservation du contexte critique
#
# Usage : bash tests/real/run-all.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
TSX="$ROOT/node_modules/.bin/tsx"

echo ""
echo "╔═══════════════════════════════════════════════════════════════════╗"
echo "║        cork-ai — Suite de tests complète                          ║"
echo "╚═══════════════════════════════════════════════════════════════════╝"
echo ""

S1_EXIT=0
S2_EXIT=0
S3_EXIT=0

echo "── Suite 1 : Stats coherence (vitest) ─────────────────────────────"
cd "$ROOT" && npx vitest run tests/suite1-stats-coherence.test.ts --reporter=verbose || S1_EXIT=$?

echo ""
echo "── Suite 2 : Benchmark sessions Claude Code ────────────────────────"
"$TSX" "$SCRIPT_DIR/suite2-benchmark.ts" || S2_EXIT=$?

echo ""
echo "── Suite 3 : Préservation du contexte ──────────────────────────────"
"$TSX" "$SCRIPT_DIR/suite3-context-preservation.ts" || S3_EXIT=$?

echo ""
echo "═══════════════════════════════════════════════════════════════════"
if [ "$S1_EXIT" -eq 0 ] && [ "$S2_EXIT" -eq 0 ] && [ "$S3_EXIT" -eq 0 ]; then
  echo "✓ Toutes les suites ont réussi."
  exit 0
else
  echo "✗ Échecs détectés — suite1=$S1_EXIT suite2=$S2_EXIT suite3=$S3_EXIT"
  exit 1
fi
