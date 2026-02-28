# arm-perf-analyzer

Profile and optimize hot loops on ARM (Neoverse-N1 / Apple Silicon).

Finds decode bottlenecks, cache misses, branch mispredictions, stall cycles, and macro-op fusion opportunities in your code. Suggests concrete optimizations.

## What it does

1. **Profile** — Runs your binary with hardware performance counters
2. **Annotate** — Shows per-function and per-line hotspots
3. **Analyze** — Identifies bottlenecks (frontend stalls, backend stalls, cache thrashing, branch misses)
4. **Suggest** — Recommends loop fission, alignment, prefetch, branchless alternatives
5. **Compare** — Before/after benchmarking
6. **Fusion Analysis** — Identifies macro-op fusion opportunities (Apple Silicon vs standard ARM)

## Quick Start

### Linux (Neoverse-N1/N2/V1)

```bash
# Profile a binary
./analyze.sh ./my-program --args "input.txt"

# Profile a specific function
./analyze.sh ./my-program --function hot_loop
```

### macOS (Apple Silicon M1/M2/M3/M4)

```bash
# Profile a binary (uses powermetrics, xctrace, sample)
./analyze-mac.sh ./my-program --args "input.txt"

# Profile with specific chip model
./analyze-mac.sh ./my-program --chip m4

# Specific function + longer sampling
./analyze-mac.sh ./my-program --function hot_loop --duration 10
```

**Note:** `powermetrics` requires `sudo` for hardware counters. Without sudo, the analyzer falls back to timing-based analysis and stack sampling.

### Fusion Analysis (cross-platform)

```bash
# Analyze a binary for macro-op fusion
node fusion-check.js ./my-program

# Analyze specific function with details
node fusion-check.js ./my-program --function hot_loop --verbose

# Analyze existing objdump output
node fusion-check.js --objdump disassembly.txt
```

## Supported Hardware

### Linux (perf)
- ARM Neoverse-N1 (Ampere Altra, Oracle Cloud, AWS Graviton 2)
- ARM Neoverse-N2 (AWS Graviton 3)
- ARM Neoverse-V1/V2 (AWS Graviton 3E/4)

### macOS (powermetrics + Instruments)
- Apple M1 (Firestorm/Icestorm)
- Apple M2 (Avalanche/Blizzard)
- Apple M3 (Everest/Sawtooth)
- Apple M4 (enhanced Everest/Sawtooth)

## Apple Silicon Architecture Reference

### P-core (Performance) — Firestorm-class

| Feature | Apple M-series | Neoverse-N1 |
|---------|---------------|-------------|
| Decode width | 8 insn/cycle | 4 insn/cycle |
| Issue width | ~9 µops/cycle | 8 µops/cycle |
| ROB size | ~630 entries | 128 entries |
| L1I cache | 192KB | 64KB |
| L1D cache | 128KB | 64KB |
| L2 cache | 12-16MB (shared) | 1MB |
| Branch mispredict | ~14 cycles | ~13 cycles |
| Max fusion/cycle | 3 pairs | 1 pair |

### Macro-op Fusion

Apple Silicon fuses more aggressively than standard ARM cores:

**Standard (both Apple + N1):**
- CMP/CMN/TST + B.cond
- ADDS/SUBS + B.cond

**Apple-specific (not on N1/N2):**
- ADD/SUB + B.cond
- ADRP + ADD (address generation fusion)
- ADRP + LDR (address generation fusion)
- AESE/AESD + AESMC (crypto fusion)

### Key Cycle Counts (Firestorm P-core)

From [Dougall Johnson's reverse engineering](https://dougallj.github.io/applecpu/firestorm.html):

- ADD/SUB/CMP: 1 cycle latency, 6/cycle throughput
- MUL/MADD: 3 cycle latency, 2/cycle throughput
- LDR (L1 hit): 3 cycle latency, 2/cycle throughput
- FADD: 3 cycle latency, 4/cycle throughput
- FMUL/FMADD: 4 cycle latency, 4/cycle throughput
- AESE+AESMC (fused): 5 cycle latency, 2/cycle throughput

## Files

| File | Description |
|------|-------------|
| `analyze.sh` | Linux profiling script (uses `perf`) |
| `analyze-mac.sh` | macOS profiling script (powermetrics, xctrace, sample) |
| `analyzer.js` | Neoverse-N1 analysis engine |
| `analyzer-apple.js` | Apple Silicon analysis engine (M1-M4 microarchitecture) |
| `fusion-check.js` | Cross-platform macro-op fusion analyzer |

## References

- [Dougall Johnson — Apple CPU Microarchitecture](https://dougallj.github.io/applecpu/firestorm.html)
- [LLVM Apple CPU Scheduling Models](https://github.com/llvm/llvm-project/tree/main/llvm/lib/Target/AArch64)
- [Anandtech M1 Deep Dive](https://www.anandtech.com/show/16226/apple-silicon-m1-a14-deep-dive)
- [Apple WWDC Performance Sessions](https://developer.apple.com/videos/)

## License

MIT
