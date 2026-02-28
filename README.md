# arm-perf-analyzer

Profile and optimize hot loops on ARM (Neoverse-N1 / Apple Silicon).

Finds decode bottlenecks, cache misses, branch mispredictions, and stall cycles in your code. Suggests concrete optimizations.

## What it does

1. **Profile** — Runs your binary with hardware performance counters
2. **Annotate** — Shows per-function and per-line hotspots
3. **Analyze** — Identifies bottlenecks (frontend stalls, backend stalls, cache thrashing, branch misses)
4. **Suggest** — Recommends loop fission, alignment, prefetch, branchless alternatives
5. **Compare** — Before/after benchmarking

## Quick Start

```bash
# Profile a binary
./analyze.sh ./my-program --args "input.txt"

# Profile a specific function
./analyze.sh ./my-program --function hot_loop

# Profile llama.cpp inference
./analyze.sh ./llama-cli --args "-m model.gguf -p hello"
```

## Supported Hardware

- ARM Neoverse-N1 (Ampere Altra, Oracle Cloud, AWS Graviton 2)
- ARM Neoverse-N2 (AWS Graviton 3)
- ARM Neoverse-V1/V2 (AWS Graviton 3E/4)
- Apple M1/M2/M3/M4 (via macOS Instruments bridge — coming)

## License

MIT
