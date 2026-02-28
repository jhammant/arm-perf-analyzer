#!/bin/bash
# analyze-mac.sh — Profile ARM binaries on macOS Apple Silicon
# Usage: ./analyze-mac.sh <binary> [--args "..."] [--function name] [--chip m1|m2|m3|m4]
#
# Tools used (in order of preference):
#   1. powermetrics (sudo) — hardware counters, power, frequency
#   2. xctrace (Instruments CLI) — per-function sampling
#   3. /usr/bin/sample — quick stack sampling (no sudo needed)
#   4. Timing fallback — wall/user/sys time via high-res clock

set -e

BINARY=""
ARGS=""
FUNCTION=""
CHIP="auto"
OUTPUT_DIR="./results/$(date +%Y%m%d-%H%M%S)"
DURATION=5  # seconds for powermetrics

while [[ $# -gt 0 ]]; do
  case $1 in
    --args) ARGS="$2"; shift 2 ;;
    --function) FUNCTION="$2"; shift 2 ;;
    --chip) CHIP="$2"; shift 2 ;;
    --output) OUTPUT_DIR="$2"; shift 2 ;;
    --duration) DURATION="$2"; shift 2 ;;
    *) BINARY="$1"; shift ;;
  esac
done

if [ -z "$BINARY" ]; then
  echo "Usage: ./analyze-mac.sh <binary> [--args '...'] [--function name] [--chip m1|m2|m3|m4]"
  exit 1
fi

# ── Platform check ───────────────────────────────────────────────────────────

if [ "$(uname)" != "Darwin" ]; then
  echo "Error: This script requires macOS. Use analyze.sh for Linux."
  exit 1
fi

if [ "$(uname -m)" != "arm64" ]; then
  echo "Error: This script requires Apple Silicon (arm64). Detected: $(uname -m)"
  exit 1
fi

mkdir -p "$OUTPUT_DIR"

# Detect chip
if [ "$CHIP" = "auto" ]; then
  CHIP_NAME=$(sysctl -n machdep.cpu.brand_string 2>/dev/null || echo "Apple Silicon")
  case "$CHIP_NAME" in
    *M4*) CHIP="m4" ;;
    *M3*) CHIP="m3" ;;
    *M2*) CHIP="m2" ;;
    *M1*) CHIP="m1" ;;
    *) CHIP="m4" ;;  # default
  esac
else
  CHIP_NAME="Apple $CHIP"
fi

echo "═══════════════════════════════════════════════════════════"
echo "  Apple Silicon Performance Analyzer"
echo "  Binary: $BINARY"
echo "  Chip: $CHIP_NAME ($CHIP)"
echo "  macOS $(sw_vers -productVersion)"
echo "═══════════════════════════════════════════════════════════"
echo ""

# Save metadata
cat > "$OUTPUT_DIR/meta.json" << EOF
{
  "binary": "$BINARY",
  "args": "$ARGS",
  "cpu": "$CHIP_NAME",
  "chip": "$CHIP",
  "arch": "arm64",
  "os": "macOS $(sw_vers -productVersion)",
  "kernel": "$(uname -r)",
  "timestamp": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
EOF

# ── Phase 1: Timing (always available) ───────────────────────────────────────

echo "▶ Phase 1: Timing analysis..."

# Use /usr/bin/time for resource usage, plus high-res timing
START_NS=$(python3 -c "import time; print(int(time.time_ns()))")

/usr/bin/time -l $BINARY $ARGS > "$OUTPUT_DIR/stdout.txt" 2> "$OUTPUT_DIR/time-output.txt" || true

END_NS=$(python3 -c "import time; print(int(time.time_ns()))")
WALL_NS=$((END_NS - START_NS))

# Parse /usr/bin/time output
USER_TIME=$(grep "user" "$OUTPUT_DIR/time-output.txt" | head -1 | awk '{print $1}' || echo "0")
SYS_TIME=$(grep "sys" "$OUTPUT_DIR/time-output.txt" | head -1 | awk '{print $1}' || echo "0")
MAX_RSS=$(grep "maximum resident" "$OUTPUT_DIR/time-output.txt" | awk '{print $1}' || echo "0")
PAGE_FAULTS=$(grep "page faults" "$OUTPUT_DIR/time-output.txt" | head -1 | awk '{print $1}' || echo "0")

cat > "$OUTPUT_DIR/timing.txt" << EOF
wall_time_ns: $WALL_NS
user_time_s: $USER_TIME
sys_time_s: $SYS_TIME
max_rss_bytes: $MAX_RSS
page_faults: $PAGE_FAULTS
EOF

echo "  → Wall time: $(echo "scale=2; $WALL_NS / 1000000" | bc) ms"

# ── Phase 2: powermetrics (needs sudo) ───────────────────────────────────────

echo "▶ Phase 2: Hardware counters (powermetrics)..."

if command -v powermetrics &>/dev/null; then
  if sudo -n true 2>/dev/null; then
    # Run binary in background, capture powermetrics during execution
    $BINARY $ARGS &>/dev/null &
    BIN_PID=$!
    
    sudo powermetrics \
      --samplers cpu_power,tasks \
      --sample-count 3 \
      --sample-rate $(( DURATION * 1000 / 3 )) \
      -i $(( DURATION * 1000 / 3 )) \
      --show-process-energy \
      -o "$OUTPUT_DIR/powermetrics.txt" 2>/dev/null || true
    
    # Kill binary if still running
    kill $BIN_PID 2>/dev/null || true
    wait $BIN_PID 2>/dev/null || true
    
    echo "  → Saved to $OUTPUT_DIR/powermetrics.txt"
  else
    echo "  ⚠ Skipped: sudo required for powermetrics (run with sudo or add NOPASSWD)"
    echo "  Tip: sudo powermetrics --samplers cpu_power -n 1"
  fi
else
  echo "  ⚠ powermetrics not found"
fi

# ── Phase 3: xctrace (Instruments CLI) ──────────────────────────────────────

echo "▶ Phase 3: Per-function sampling (xctrace)..."

if command -v xctrace &>/dev/null; then
  TRACE_FILE="$OUTPUT_DIR/profile.trace"
  
  # Use Time Profiler template
  xctrace record \
    --template "Time Profiler" \
    --output "$TRACE_FILE" \
    --time-limit "${DURATION}s" \
    --launch -- $BINARY $ARGS 2>/dev/null || true
  
  if [ -d "$TRACE_FILE" ]; then
    # Export symbols from trace
    xctrace export \
      --input "$TRACE_FILE" \
      --xpath '/trace-toc/run/data/table[@schema="time-profile"]' \
      > "$OUTPUT_DIR/xctrace-export.xml" 2>/dev/null || true
    echo "  → Saved trace to $TRACE_FILE"
  else
    echo "  ⚠ xctrace recording failed (Xcode may not be installed)"
  fi
else
  echo "  ⚠ xctrace not found (install Xcode or Command Line Tools)"
fi

# ── Phase 4: /usr/bin/sample (always available, no sudo) ────────────────────

echo "▶ Phase 4: Quick stack sampling..."

if command -v sample &>/dev/null; then
  # Run binary and sample it
  $BINARY $ARGS &>/dev/null &
  BIN_PID=$!
  
  sleep 0.5  # Let it start
  
  if kill -0 $BIN_PID 2>/dev/null; then
    sample $BIN_PID $DURATION -file "$OUTPUT_DIR/sample-output.txt" 2>/dev/null || true
    kill $BIN_PID 2>/dev/null || true
    wait $BIN_PID 2>/dev/null || true
    echo "  → Saved to $OUTPUT_DIR/sample-output.txt"
  else
    echo "  ⚠ Process exited too quickly for sampling"
  fi
else
  echo "  ⚠ sample command not found"
fi

# ── Phase 5: Disassembly (for fusion analysis) ──────────────────────────────

echo "▶ Phase 5: Disassembly..."

OBJDUMP=""
if command -v llvm-objdump &>/dev/null; then
  OBJDUMP="llvm-objdump"
elif command -v objdump &>/dev/null; then
  OBJDUMP="objdump"
elif [ -f "/usr/bin/objdump" ]; then
  OBJDUMP="/usr/bin/objdump"
fi

if [ -n "$OBJDUMP" ]; then
  if [ -n "$FUNCTION" ]; then
    $OBJDUMP -d --disassemble-symbols="$FUNCTION" "$BINARY" \
      > "$OUTPUT_DIR/disasm-$FUNCTION.txt" 2>/dev/null || true
    echo "  → Disassembled: $FUNCTION"
  fi
  
  # Also dump full disassembly for fusion analysis
  $OBJDUMP -d "$BINARY" > "$OUTPUT_DIR/disasm-full.txt" 2>/dev/null || true
  echo "  → Full disassembly saved"
else
  echo "  ⚠ No objdump found — install Xcode Command Line Tools"
fi

# ── Phase 6: Top functions (from sample output) ─────────────────────────────

echo "▶ Phase 6: Generating top functions..."

if [ -f "$OUTPUT_DIR/sample-output.txt" ]; then
  # Extract function names and sample counts from sample output
  grep -E "^\s+\d+" "$OUTPUT_DIR/sample-output.txt" 2>/dev/null | \
    sort -t' ' -k1 -rn | head -20 > "$OUTPUT_DIR/top-functions.txt" || true
fi

# ── Phase 7: Analysis ───────────────────────────────────────────────────────

echo "▶ Phase 7: Analysis..."

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
node "$SCRIPT_DIR/analyzer-apple.js" "$OUTPUT_DIR" "$CHIP" > "$OUTPUT_DIR/analysis.md"

# ── Phase 8: Fusion check (if disassembly available) ────────────────────────

if [ -f "$OUTPUT_DIR/disasm-full.txt" ]; then
  echo "▶ Phase 8: Fusion analysis..."
  node "$SCRIPT_DIR/fusion-check.js" --objdump "$OUTPUT_DIR/disasm-full.txt" \
    > "$OUTPUT_DIR/fusion-report.txt" 2>/dev/null || true
  echo "  → Fusion report saved"
fi

echo ""
echo "═══════════════════════════════════════════════════════════"
echo "  Results: $OUTPUT_DIR/"
echo "═══════════════════════════════════════════════════════════"
echo ""
cat "$OUTPUT_DIR/analysis.md"

if [ -f "$OUTPUT_DIR/fusion-report.txt" ]; then
  echo ""
  echo "── Fusion Analysis ──"
  cat "$OUTPUT_DIR/fusion-report.txt"
fi
