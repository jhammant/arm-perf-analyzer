# perf-analyzer

Profile and optimize hot loops on **ARM** (Neoverse-N1) and **x86/x86_64** (Intel Skylake+ / AMD Zen 3+).

Finds decode bottlenecks, cache misses, branch mispredictions, and stall cycles in your code. Suggests concrete optimizations.

## What it does

1. **Profile** — Runs your binary with hardware performance counters
2. **Annotate** — Shows per-function and per-line hotspots
3. **Analyze** — Identifies bottlenecks (frontend stalls, backend stalls, cache thrashing, branch misses)
4. **Suggest** — Recommends loop fission, alignment, prefetch, branchless alternatives
5. **Compare** — Before/after benchmarking

## Quick Start

### ARM (Neoverse-N1 / Graviton)

```bash
./analyze.sh ./my-program --args "input.txt"
./analyze.sh ./my-program --function hot_loop
```

### x86 / x86_64 (Intel / AMD)

```bash
./analyze-x86.sh ./my-program --args "input.txt"
./analyze-x86.sh ./my-program --function hot_loop

# Force vendor (auto-detected from /proc/cpuinfo by default)
./analyze-x86.sh ./my-program --vendor intel
./analyze-x86.sh ./my-program --vendor amd
```

## x86-Specific Analysis

The x86 analyzer (`analyzer-x86.js`) focuses on frontend decode bottlenecks that are unique to the x86 CISC architecture:

### DSB / OpCache Analysis
- **Intel DSB** (Decoded Stream Buffer): Caches ~1536 decoded uops in 32-byte aligned regions. Delivers up to 6 uops/cycle — 50% more than the legacy MITE decoder.
- **AMD Op Cache**: Caches ~4096 macro-op entries. Delivers up to 8 ops/cycle — 2× the legacy decoder.
- **Hit rate tracking**: Reports DSB vs MITE vs Microcode Sequencer breakdown.
- **DSB→MITE switch detection**: Each switch costs ~5 cycles while the MITE decoder wakes up.

### Top-Down Microarchitecture Analysis (Intel)
Uses `perf stat --topdown` to break down pipeline utilization into:
- **Retiring** — useful work
- **Bad Speculation** — wasted work from mispredictions
- **Frontend Bound** — instruction supply bottlenecks
- **Backend Bound** — execution/memory bottlenecks

### Loop Fission Detection
When hot loops exceed DSB/OpCache capacity, the analyzer suggests concrete loop fission strategies:
- Split cold paths (error handling, rare conditions) into separate loops
- Keep hot loop body compact enough to fit in the uop cache
- 32-byte alignment guidance for Intel DSB set mapping

### Macro-op Fusion
Detects opportunities for CMP+Jcc, TEST+Jcc, ADD+Jcc fusion pairs. Reports anti-patterns that prevent fusion (instructions between compare and branch).

### Key PMU Events

**Intel:**
- `idq.dsb_uops` — Uops delivered from DSB (uop cache)
- `idq.mite_uops` — Uops from legacy MITE decoder
- `idq.ms_uops` — Uops from microcode sequencer
- `dsb2mite_switches.penalty_cycles` — Cycles lost to DSB→MITE switches
- `idq_uops_not_delivered.core` — Frontend starvation (pipeline bubble slots)
- `uops_issued.any` / `uops_retired.retire_slots` — Issued vs retired uops

**AMD:**
- `ic_tag_hit_miss.*` — Instruction cache hit/miss rates
- `ic_fetch_stall.ic_stall_any` — Frontend fetch stalls
- `ex_ret_ops` — Retired macro-ops

## Supported Hardware

### ARM
- Neoverse-N1 (Ampere Altra, AWS Graviton 2)
- Neoverse-N2 (AWS Graviton 3)
- Neoverse-V1/V2 (AWS Graviton 3E/4)

### x86
- Intel Skylake, Cascade Lake, Ice Lake, Alder Lake, Sapphire Rapids+
- AMD Zen 2, Zen 3, Zen 4+

## References

- [Agner Fog — Microarchitecture Manual](https://agner.org/optimize/microarchitecture.pdf)
- [Agner Fog — Instruction Tables](https://agner.org/optimize/instruction_tables.pdf)
- [Intel® 64 and IA-32 Optimization Reference Manual](https://www.intel.com/content/www/us/en/docs/architectures-software-developer-manuals/64-ia-32-architectures-optimization-manual/overview.html)
- [Intel Top-Down Microarchitecture Analysis](https://www.intel.com/content/www/us/en/docs/vtune-profiler/cookbook/current/top-down-microarchitecture-analysis-method.html)
- [AMD Software Optimization Guide](https://www.amd.com/en/support/tech-docs)
- [BOLT — Binary Optimization and Layout Tool](https://github.com/llvm/llvm-project/tree/main/bolt)

## License

MIT
