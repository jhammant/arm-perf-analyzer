# arm-perf-analyzer

Profile and optimize hot loops on ARM (AWS Graviton, Ampere Altra, Apple Silicon) and x86 (Intel, AMD). Finds decode bottlenecks, cache misses, branch mispredictions, and stall cycles. Suggests concrete, architecture-specific optimizations.

## Example: Profiling Ollama (LLM Inference) on AWS Graviton 2

```
═══════════════════════════════════════════════════════════
  ARM Performance Analyzer — aarch64
  Binary: ollama (qwen2.5:14b, system-wide during inference)
  CPU: Neoverse-N1
═══════════════════════════════════════════════════════════

IPC:              2.08 (52% of theoretical 4.0 max)
Frontend stalls:  3.8%  ← NOT the bottleneck
Backend stalls:   21.9% ← THIS is where time is lost
L1I miss rate:    0.33%
L1D miss rate:    0.61%
L2 refill rate:   5.6%
Branch miss rate: 0.10%

Top hot functions:
  9.99%  ollama  0x011f88fc  (GGML matmul kernel)
  5.27%  ollama  0x011f88f0  (adjacent — same inner loop)
  5.21%  ollama  0x0128d8fc

~15% of ALL cycles in just two adjacent addresses — that's the
quantized dot product inner loop.

Issues:
🔴 [Backend]  21.9% backend stalls — execution/memory bottleneck
🟡 [IPC]      2.08 — room for improvement (max 4.0)

Recommendations:
- Break dependency chains — use 4 accumulators instead of 2
- Software prefetch next blocks (L2 latency = 10 cycles)
- Consider loop unrolling to 4 blocks per iteration
- ROB is only 128 entries — keep dependency chains short
```

Full example outputs in [`examples/`](examples/).

## Example: Hash Table Benchmark

```
IPC:              1.68 (42% of theoretical max)
Frontend stalls:  0.9%
Backend stalls:   43.0% ← Memory-bound (random access pattern)
L1D miss rate:    2.84%
Branch miss rate: 0.72%

Issues:
🔴 [Backend] 43.0% backend stalls — execution/memory bottleneck
🟠 [IPC]     1.68 is below 50% efficiency

Recommendations:
- Add __builtin_prefetch() for predictable access patterns
- AoS → SoA transformation for hot fields
- Break dependency chains with independent accumulators
```

## Quick Start

### Linux (ARM — AWS Graviton / Ampere Altra)

```bash
./analyze.sh ./my-program --args "input.txt"
./analyze.sh ./my-program --function hot_loop
```

### Linux (x86 — Intel/AMD)

```bash
./analyze-x86.sh ./my-program --args "input.txt"
```

x86 analysis includes:
- **Intel DSB (Decoded Stream Buffer)** hit rate and capacity analysis
- **AMD OpCache** hit/miss tracking
- **DSB→MITE switches** (~5 cycle penalty each)
- **Top-down microarchitecture breakdown** (Retiring / Bad Speculation / Frontend / Backend)
- **Loop fission suggestions** when loop body exceeds DSB capacity (~4000 uops)
- **Macro-op fusion** detection (CMP+Jcc, TEST+Jcc)

### macOS (Apple Silicon M1/M2/M3/M4)

```bash
./analyze-mac.sh ./my-program --args "input.txt"
./analyze-mac.sh ./my-program --chip m4
```

`powermetrics` requires `sudo` for hardware counters. Falls back to timing + stack sampling without it.

### Fusion Analysis (cross-platform)

```bash
node fusion-check.js ./my-program
node fusion-check.js ./my-program --function hot_loop --verbose
```

Compares fusion behaviour across Apple Silicon vs Neoverse-N1 vs x86.

## Supported Hardware

| Platform | Hardware | Tool |
|----------|----------|------|
| Linux ARM | **AWS Graviton 2** (Neoverse-N1), **Graviton 3** (N2/V1), **Graviton 4** (V2), Ampere Altra/AmpereOne | `perf` |
| Linux x86 | Intel Skylake+, AMD Zen 3+ | `perf` |
| macOS | Apple M1/M2/M3/M4 | `powermetrics`, `xctrace` |

## Architecture Comparison

| Feature | Apple M4 (P-core) | Graviton 2 (N1) | Intel Skylake |
|---------|-------------------|-------------|---------------|
| Decode width | 8 insn/cycle | 4 insn/cycle | 4 uops/cycle (from DSB) |
| Issue width | ~9 µops/cycle | 8 µops/cycle | 6 µops/cycle |
| ROB size | ~630 entries | 128 entries | 224 entries |
| L1I cache | 192KB | 64KB | 32KB + 1.5K uop DSB |
| L1D cache | 128KB | 64KB | 32KB |
| Branch mispredict | ~14 cycles | ~13 cycles | ~15 cycles |
| Fusion pairs/cycle | 3 | 1 | 1 |

## Files

| File | Description |
|------|-------------|
| `analyze.sh` | ARM Linux profiling (perf) |
| `analyze-x86.sh` | x86 Linux profiling (perf, DSB/OpCache analysis) |
| `analyze-mac.sh` | macOS profiling (powermetrics, xctrace, sample) |
| `analyzer.js` | Neoverse-N1 analysis engine |
| `analyzer-x86.js` | Intel/AMD analysis (DSB, OpCache, TopDown) |
| `analyzer-apple.js` | Apple Silicon analysis (M1-M4) |
| `fusion-check.js` | Cross-platform macro-op fusion analyzer |
| `examples/` | Real profiling output from Ollama and benchmarks |

## References

- [Agner Fog — Instruction Tables](https://www.agner.org/optimize/instruction_tables.pdf)
- [Intel Optimization Manual](https://www.intel.com/content/www/us/en/docs/intrinsics-guide/)
- [Dougall Johnson — Apple CPU Microarchitecture](https://dougallj.github.io/applecpu/firestorm.html)
- [ARM Neoverse-N1 TRM](https://developer.arm.com/documentation/100616/latest)

## License

MIT
