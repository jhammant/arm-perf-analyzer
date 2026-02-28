# Neoverse-N1 Optimization Analysis: ggml_vec_dot_q4_0_q8_0

## Executive Summary

**The q4_0 NEON dot product kernel is already well-optimized.** After thorough analysis and benchmarking, the existing code + GCC -O3 `-mtune=neoverse-n1` generates near-optimal assembly. Micro-architectural optimizations (4-way unroll, split SDOT, extra accumulators, software prefetch) yield **<2% improvement** in microbenchmarks and can regress for some sizes.

The real 21.9% backend stalls observed in profiling are likely **not from the kernel itself** but from **memory subsystem pressure at matmul scale** — specifically L2/DRAM streaming of multi-MB weight matrices across 8 threads sharing 1MB L2.

## Current Hot Loop (NEON path, lines 370-411)

```c
float32x4_t sumv0 = vdupq_n_f32(0.0f);
float32x4_t sumv1 = vdupq_n_f32(0.0f);

for (; ib + 1 < nb; ib += 2) {
    // Load x blocks, unpack 4-bit→8-bit (AND+SHR), subtract 8
    // Load y blocks (2× 16-byte loads per block)
    // Chained SDOT: p = sdot(sdot(0, x_lo, y_lo), x_hi, y_hi)
    // Accumulate: sumv += cvt(p) * (x->d * y->d)   via vmlaq_n_f32
}
sumf = vaddvq_f32(sumv0) + vaddvq_f32(sumv1);
```

## Compiler Output Analysis (GCC -O3)

The compiler **decomposes `vmlaq_n_f32`** into separate `FMUL` + `FADD`. This means:
- The accumulation dependency is a **2-cycle FADD** (not 4-cycle FMLA)
- With 2 accumulators and ~14 cycles/iteration, FADD latency is fully hidden
- Adding more accumulators provides **zero benefit**

### Instruction Mix per Iteration (2 blocks)

| Category | Count | Port | Cycles (min) |
|----------|-------|------|-------------|
| Q-register loads | 6 | LD (2/cyc) | 3 |
| H-register loads | 4 | LD (2/cyc) | 2 |
| AND/SHR/SUB (int) | 8 | V0/V1 | 4 |
| SDOT | 4 | V0/V1 | 2 |
| SCVTF | 2 | V0/V1 | 1 |
| FMUL (vec) | 2 | V0/V1 | 1 |
| FADD (vec) | 2 | V0/V1 | 1 |
| Scalar FCVT | 4 | FP | 4 |
| Scalar FMUL | 2 | FP | 2 |
| Loop overhead | 2 | Branch | 1 |
| **Total** | **36** | | **~14 measured** |

At ~2.5 GHz: 14 cycles = 5.6 ns/iteration = 355 ns for 128 blocks (n=4096).

**The loop is compute-bound**, not memory-bound at micro-benchmark scale (everything in L1).

## Optimizations Attempted & Results

### 1. Four Accumulators + 4-Way Unroll
- **Hypothesis:** More accumulators hide FMLA latency, more blocks per iteration give OoO more work
- **Result:** ≤1% change (within noise). The compiler's FMUL+FADD decomposition already hides latency with just 2 accumulators.
- **Verdict:** ❌ No benefit

### 2. Split Chained SDOT into Parallel SDOT+SDOT+VADD
- **Hypothesis:** Two independent SDOTs can execute on both NEON pipes simultaneously
- **Result:** **-14% regression.** The chained SDOT (`sdot(sdot(0, a, b), c, d)`) uses the accumulator form which is free — adding a VADD is strictly worse.
- **Verdict:** ❌ Harmful

### 3. Software Prefetching
- **Hypothesis:** L2 refill rate of 5.6% means prefetching future blocks helps
- **Result:** ~4% gain at medium sizes (4K-32K elements), but -5% to -12% regression at large sizes (>64K) due to prefetch pollution. Negligible at small sizes.
- **Verdict:** ⚠️ Context-dependent, not safe for upstream

### 4. Loop-Invariant Hoisting (m4b, s8b constants)
- **Hypothesis:** Moving constant creation outside the loop saves instructions
- **Result:** GCC already hoists these at -O3. Zero effect.
- **Verdict:** ❌ Already done by compiler

## FP16→FP32 Conversion

`GGML_CPU_FP16_TO_FP32` on NEON uses:
```c
static inline float neon_compute_fp16_to_fp32(ggml_fp16_t h) {
    __fp16 tmp;
    memcpy(&tmp, &h, sizeof(ggml_fp16_t));
    return (float)tmp;
}
```

This compiles to a single `FCVT s0, h0` instruction (1-cycle latency on N1). It's optimal — using the hardware FP16→FP32 conversion. No optimization needed.

## Where the Real 21.9% Backend Stalls Come From

The profiling showed 15% of cycles in two adjacent addresses in the matmul kernel. In a microbenchmark with data in L1, we see near-peak throughput. The stalls in real workloads come from:

1. **L2/DRAM streaming:** A 14B parameter model with Q4_0 quantization stores ~7GB of weights. Each token generation reads significant portions. With 8 threads sharing 1MB L2, data streams from DRAM constantly.

2. **Memory bandwidth saturation:** 8 cores × 19 GB/s effective throughput = 152 GB/s demand vs typical DDR4 bandwidth of 25-50 GB/s on Graviton2/similar.

3. **Inter-thread L2 contention:** All 8 cores share the L2. When multiple threads process different rows of the weight matrix, they compete for L2 capacity and bandwidth.

### What Would Actually Help

| Optimization | Expected Impact | Where |
|-------------|----------------|-------|
| **Matmul tiling for L2** | 10-20% | ggml-cpu mul_mat | 
| **Thread-aware data placement** | 5-15% | ggml-cpu threading |
| **Batch processing (nrc>1)** | 10-30% | Already exists for i8mm, need SDOT path |
| **Better quantization (Q4_K)** | 5-15% | Already default in most models |

## Other Hot Kernels

All NEON dot-product kernels share the same 2-accumulator + chained-SDOT pattern:
- `q4_1_q8_1`, `q5_0_q8_0`, `q5_1_q8_1`, `q8_0_q8_0` — same structure, same conclusions
- The q4_K/q5_K/q6_K kernels (in ggml-cpu-quants.c) use K-quant formats with more complex scale handling but the same SDOT core

The same analysis applies: the kernels themselves are already well-optimized; gains must come from the surrounding matmul infrastructure.

## Conclusion

The llama.cpp NEON kernel code is production-quality. The upstream developers and GCC have already found the sweet spot for this micro-architecture. The path to better performance on Neoverse-N1 is:

1. **Higher-level:** Better matmul tiling, thread scheduling, memory management
2. **Hardware:** N1 lacks i8mm/MMLA (which gives 2x throughput for int8 matmul). Neoverse-V1/N2 with SVE2 + i8mm would be significantly faster
3. **Model-level:** Use Q4_K_M instead of Q4_0 (better quality per bit, and the K-quant kernels have similar throughput)
