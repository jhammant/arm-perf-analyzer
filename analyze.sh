#!/bin/bash
# arm-perf-analyzer — Profile and analyze ARM binaries
# Usage: ./analyze.sh <binary> [--args "..."] [--function name] [--compare before.json]

set -e

BINARY=""
ARGS=""
FUNCTION=""
COMPARE=""
OUTPUT_DIR="./results/$(date +%Y%m%d-%H%M%S)"

while [[ $# -gt 0 ]]; do
  case $1 in
    --args) ARGS="$2"; shift 2 ;;
    --function) FUNCTION="$2"; shift 2 ;;
    --compare) COMPARE="$2"; shift 2 ;;
    --output) OUTPUT_DIR="$2"; shift 2 ;;
    *) BINARY="$1"; shift ;;
  esac
done

if [ -z "$BINARY" ]; then
  echo "Usage: ./analyze.sh <binary> [--args '...'] [--function name]"
  exit 1
fi

mkdir -p "$OUTPUT_DIR"

echo "═══════════════════════════════════════════════════════════"
echo "  ARM Performance Analyzer — $(uname -m)"
echo "  Binary: $BINARY"
echo "  CPU: $(lscpu | grep 'Model name' | sed 's/.*: *//')"
echo "═══════════════════════════════════════════════════════════"
echo ""

# ── Phase 1: High-level profiling ────────────────────────────────────────────

echo "▶ Phase 1: Hardware counters..."

perf stat -e cycles,instructions,stalled-cycles-frontend,stalled-cycles-backend,cache-references,cache-misses,branch-loads,branch-misses,L1-icache-loads,L1-icache-load-misses,L1-dcache-loads,L1-dcache-load-misses,iTLB-loads,iTLB-load-misses,dTLB-loads,dTLB-load-misses -o "$OUTPUT_DIR/perf-stat.txt" -- $BINARY $ARGS 2>&1

echo "  → Saved to $OUTPUT_DIR/perf-stat.txt"

# ── Phase 2: ARM-specific events ─────────────────────────────────────────────

echo "▶ Phase 2: ARM PMU events..."

perf stat -e l1i_cache,l1i_cache_refill,l1d_cache,l1d_cache_refill,l2d_cache,l2d_cache_refill,br_pred,br_mis_pred -o "$OUTPUT_DIR/arm-pmu.txt" -- $BINARY $ARGS 2>&1

echo "  → Saved to $OUTPUT_DIR/arm-pmu.txt"

# ── Phase 3: Record samples for per-function analysis ────────────────────────

echo "▶ Phase 3: Sampling (10ms)..."

perf record -g -F 999 -o "$OUTPUT_DIR/perf.data" \
  -- $BINARY $ARGS 2>&1

echo "  → Recorded to $OUTPUT_DIR/perf.data"

# ── Phase 4: Generate reports ────────────────────────────────────────────────

echo "▶ Phase 4: Generating reports..."

# Top functions
perf report -i "$OUTPUT_DIR/perf.data" --stdio --no-children \
  > "$OUTPUT_DIR/top-functions.txt" 2>/dev/null

# If specific function requested, annotate it
if [ -n "$FUNCTION" ]; then
  perf annotate -i "$OUTPUT_DIR/perf.data" --stdio -s "$FUNCTION" \
    > "$OUTPUT_DIR/annotate-$FUNCTION.txt" 2>/dev/null
  echo "  → Annotated: $FUNCTION"
fi

# ── Phase 5: Analysis ────────────────────────────────────────────────────────

echo "▶ Phase 5: Analysis..."

node "$(dirname "$0")/analyzer.js" "$OUTPUT_DIR" > "$OUTPUT_DIR/analysis.md"

echo ""
echo "═══════════════════════════════════════════════════════════"
echo "  Results: $OUTPUT_DIR/"
echo "═══════════════════════════════════════════════════════════"
echo ""
cat "$OUTPUT_DIR/analysis.md"

# Save metadata
cat > "$OUTPUT_DIR/meta.json" << EOF
{
  "binary": "$BINARY",
  "args": "$ARGS",
  "cpu": "$(lscpu | grep 'Model name' | sed 's/.*: *//')",
  "arch": "$(uname -m)",
  "kernel": "$(uname -r)",
  "timestamp": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
EOF
