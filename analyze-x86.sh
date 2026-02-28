#!/bin/bash
# x86 Performance Analyzer — Profile and analyze x86/x86_64 binaries
# Focus: DSB/OpCache hit rates, frontend decode bottlenecks, top-down analysis
# Usage: ./analyze-x86.sh <binary> [--args "..."] [--function name] [--vendor intel|amd]

set -e

BINARY=""
ARGS=""
FUNCTION=""
VENDOR=""
OUTPUT_DIR="./results/$(date +%Y%m%d-%H%M%S)"

while [[ $# -gt 0 ]]; do
  case $1 in
    --args) ARGS="$2"; shift 2 ;;
    --function) FUNCTION="$2"; shift 2 ;;
    --vendor) VENDOR="$2"; shift 2 ;;
    --output) OUTPUT_DIR="$2"; shift 2 ;;
    *) BINARY="$1"; shift ;;
  esac
done

if [ -z "$BINARY" ]; then
  echo "Usage: ./analyze-x86.sh <binary> [--args '...'] [--function name] [--vendor intel|amd]"
  exit 1
fi

mkdir -p "$OUTPUT_DIR"

# Auto-detect vendor if not specified
if [ -z "$VENDOR" ]; then
  VENDOR_ID=$(grep -m1 'vendor_id' /proc/cpuinfo | awk '{print $3}')
  case "$VENDOR_ID" in
    GenuineIntel) VENDOR="intel" ;;
    AuthenticAMD) VENDOR="amd" ;;
    *) VENDOR="intel"; echo "⚠ Unknown vendor '$VENDOR_ID', defaulting to Intel events" ;;
  esac
fi

CPU_MODEL=$(lscpu | grep 'Model name' | sed 's/.*: *//')
echo "═══════════════════════════════════════════════════════════"
echo "  x86 Performance Analyzer — $(uname -m)"
echo "  Binary: $BINARY"
echo "  CPU: $CPU_MODEL"
echo "  Vendor: $VENDOR"
echo "═══════════════════════════════════════════════════════════"
echo ""

# ── Phase 1: Generic hardware counters ───────────────────────────────────────

echo "▶ Phase 1: Hardware counters..."

perf stat -e cycles,instructions,stalled-cycles-frontend,stalled-cycles-backend,cache-references,cache-misses,branch-loads,branch-misses,L1-icache-loads,L1-icache-load-misses,L1-dcache-loads,L1-dcache-load-misses,iTLB-loads,iTLB-load-misses,dTLB-loads,dTLB-load-misses \
  -o "$OUTPUT_DIR/perf-stat.txt" -- $BINARY $ARGS 2>&1

echo "  → Saved to $OUTPUT_DIR/perf-stat.txt"

# ── Phase 2: Vendor-specific frontend/uop events ────────────────────────────

echo "▶ Phase 2: $VENDOR frontend decode events..."

if [ "$VENDOR" = "intel" ]; then
  # Intel DSB (Decoded Stream Buffer) / MITE / LSD events
  # These are the key events for understanding frontend decode bottlenecks
  perf stat -e \
    idq.dsb_uops,\
    idq.mite_uops,\
    idq.ms_uops,\
    dsb2mite_switches.penalty_cycles,\
    idq_uops_not_delivered.core,\
    uops_issued.any,\
    uops_retired.retire_slots,\
    frontend_retired.dsb_miss,\
    frontend_retired.l1i_miss,\
    frontend_retired.itlb_miss \
    -o "$OUTPUT_DIR/x86-frontend.txt" -- $BINARY $ARGS 2>&1 || \
  # Fallback for older Intel CPUs (pre-Skylake event names)
  perf stat -e \
    idq.dsb_uops,\
    idq.mite_uops,\
    idq.ms_uops,\
    dsb2mite_switches.penalty_cycles,\
    idq_uops_not_delivered.core,\
    uops_issued.any,\
    uops_retired.all \
    -o "$OUTPUT_DIR/x86-frontend.txt" -- $BINARY $ARGS 2>&1 || \
  echo "  ⚠ Some Intel events not available on this CPU"

  echo "  → Saved to $OUTPUT_DIR/x86-frontend.txt"

  # Top-down microarchitecture analysis (level 1)
  echo "▶ Phase 2b: Top-down analysis..."
  perf stat --topdown -o "$OUTPUT_DIR/x86-topdown.txt" -- $BINARY $ARGS 2>&1 || \
    echo "  ⚠ Top-down analysis not available (needs kernel 4.14+ and supported CPU)"
  echo "  → Saved to $OUTPUT_DIR/x86-topdown.txt"

elif [ "$VENDOR" = "amd" ]; then
  # AMD Op Cache / Decoder events (Zen 2+)
  perf stat -e \
    ex_ret_ops,\
    de_src_op_disp.all,\
    de_dis_cops_from_decoder.all,\
    de_dis_cops_from_decoder.fp,\
    ic_fetch_stall.ic_stall_any,\
    ic_tag_hit_miss.all_instruction_cache_accesses,\
    ic_tag_hit_miss.instruction_cache_hit,\
    ic_tag_hit_miss.instruction_cache_miss,\
    bp_l1_tlb_miss_l2_tlb_hit,\
    bp_l1_tlb_miss_l2_tlb_miss \
    -o "$OUTPUT_DIR/x86-frontend.txt" -- $BINARY $ARGS 2>&1 || \
  # Fallback for different AMD event naming
  perf stat -e \
    ex_ret_ops,\
    ic_fetch_stall.ic_stall_any \
    -o "$OUTPUT_DIR/x86-frontend.txt" -- $BINARY $ARGS 2>&1 || \
  echo "  ⚠ Some AMD events not available on this CPU"

  echo "  → Saved to $OUTPUT_DIR/x86-frontend.txt"
fi

# ── Phase 3: Record samples for per-function analysis ────────────────────────

echo "▶ Phase 3: Sampling..."

perf record -g -F 999 -o "$OUTPUT_DIR/perf.data" \
  -- $BINARY $ARGS 2>&1

echo "  → Recorded to $OUTPUT_DIR/perf.data"

# ── Phase 4: Generate reports ────────────────────────────────────────────────

echo "▶ Phase 4: Generating reports..."

perf report -i "$OUTPUT_DIR/perf.data" --stdio --no-children \
  > "$OUTPUT_DIR/top-functions.txt" 2>/dev/null

if [ -n "$FUNCTION" ]; then
  perf annotate -i "$OUTPUT_DIR/perf.data" --stdio -s "$FUNCTION" \
    > "$OUTPUT_DIR/annotate-$FUNCTION.txt" 2>/dev/null
  echo "  → Annotated: $FUNCTION"
fi

# ── Phase 5: Analysis ────────────────────────────────────────────────────────

echo "▶ Phase 5: Analysis..."

node "$(dirname "$0")/analyzer-x86.js" "$OUTPUT_DIR" "$VENDOR" > "$OUTPUT_DIR/analysis.md"

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
  "cpu": "$CPU_MODEL",
  "arch": "$(uname -m)",
  "vendor": "$VENDOR",
  "kernel": "$(uname -r)",
  "timestamp": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
EOF
