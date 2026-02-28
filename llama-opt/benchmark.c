/*
 * Benchmark: Original vs Optimized q4_0 dot product
 *
 * Build: make
 * Run:   ./benchmark [n_elements]
 *
 * Default n=4096 (128 blocks of 32 elements) — typical for a single
 * row in a quantized model layer.
 */

#include <stdio.h>
#include <stdlib.h>
#include <stdint.h>
#include <string.h>
#include <time.h>
#include <math.h>
#include <arm_neon.h>

/* ---- Types ---- */
typedef uint16_t ggml_fp16_t;

#define QK4_0 32
#define QK8_0 32

typedef struct {
    ggml_fp16_t d;
    uint8_t qs[QK4_0 / 2];
} block_q4_0;

typedef struct {
    ggml_fp16_t d;
    int8_t qs[QK8_0];
} block_q8_0;

/* ---- FP16 helpers ---- */
static inline float fp16_to_fp32(ggml_fp16_t h) {
    __fp16 tmp;
    memcpy(&tmp, &h, sizeof(ggml_fp16_t));
    return (float)tmp;
}

static inline ggml_fp16_t fp32_to_fp16(float f) {
    __fp16 tmp = (__fp16)f;
    ggml_fp16_t r;
    memcpy(&r, &tmp, sizeof(ggml_fp16_t));
    return r;
}

#define Q4_0_TYPES_DEFINED
#include "q4_0_optimized.c"

/* ---- Data generation ---- */
static void generate_q4_0_blocks(block_q4_0 *blocks, int nb) {
    for (int i = 0; i < nb; i++) {
        blocks[i].d = fp32_to_fp16(0.1f + 0.001f * (i % 100));
        for (int j = 0; j < QK4_0/2; j++) {
            /* Random nibble pairs */
            blocks[i].qs[j] = (uint8_t)(((i * 7 + j * 13) % 256));
        }
    }
}

static void generate_q8_0_blocks(block_q8_0 *blocks, int nb) {
    for (int i = 0; i < nb; i++) {
        blocks[i].d = fp32_to_fp16(0.05f + 0.002f * (i % 50));
        for (int j = 0; j < QK8_0; j++) {
            blocks[i].qs[j] = (int8_t)((i * 11 + j * 17) % 256 - 128);
        }
    }
}

/* ---- Timing ---- */
static inline uint64_t get_ns(void) {
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return (uint64_t)ts.tv_sec * 1000000000ULL + ts.tv_nsec;
}

/* ---- Main ---- */
int main(int argc, char **argv) {
    int n = 4096;  /* elements (must be multiple of QK4_0=32) */
    if (argc > 1) n = atoi(argv[1]);
    if (n < 32) n = 32;
    n = (n / 32) * 32;  /* round down */

    const int nb = n / QK4_0;
    const int warmup = 1000;
    const int iterations = 100000;

    printf("Benchmark: q4_0 dot product (n=%d, %d blocks)\n", n, nb);
    printf("Iterations: %d (warmup: %d)\n\n", iterations, warmup);

    /* Allocate aligned */
    block_q4_0 *x = aligned_alloc(64, nb * sizeof(block_q4_0));
    block_q8_0 *y = aligned_alloc(64, nb * sizeof(block_q8_0));

    generate_q4_0_blocks(x, nb);
    generate_q8_0_blocks(y, nb);

    float result_orig = 0, result_opt = 0;

    /* ---- Warmup ---- */
    for (int i = 0; i < warmup; i++) {
        vec_dot_q4_0_q8_0_original(n, &result_orig, x, y);
        vec_dot_q4_0_q8_0_optimized(n, &result_opt, x, y);
    }

    /* ---- Verify correctness ---- */
    vec_dot_q4_0_q8_0_original(n, &result_orig, x, y);
    vec_dot_q4_0_q8_0_optimized(n, &result_opt, x, y);

    float diff = fabsf(result_orig - result_opt);
    float rel_err = diff / (fabsf(result_orig) + 1e-10f);
    printf("Correctness check:\n");
    printf("  Original:  %.6f\n", result_orig);
    printf("  Optimized: %.6f\n", result_opt);
    printf("  Abs diff:  %.2e\n", diff);
    printf("  Rel error: %.2e\n", rel_err);
    printf("  Status:    %s\n\n", rel_err < 1e-5 ? "PASS ✓" : "FAIL ✗");

    /* ---- Benchmark original ---- */
    uint64_t t0 = get_ns();
    for (int i = 0; i < iterations; i++) {
        vec_dot_q4_0_q8_0_original(n, &result_orig, x, y);
        /* Prevent dead code elimination */
        __asm__ volatile("" :: "r"(result_orig));
    }
    uint64_t t1 = get_ns();
    double ns_orig = (double)(t1 - t0) / iterations;

    /* ---- Benchmark optimized ---- */
    t0 = get_ns();
    for (int i = 0; i < iterations; i++) {
        vec_dot_q4_0_q8_0_optimized(n, &result_opt, x, y);
        __asm__ volatile("" :: "r"(result_opt));
    }
    t1 = get_ns();
    double ns_opt = (double)(t1 - t0) / iterations;

    /* ---- Results ---- */
    double speedup = ns_orig / ns_opt;
    printf("Results (avg per call):\n");
    printf("  Original:  %8.1f ns\n", ns_orig);
    printf("  Optimized: %8.1f ns\n", ns_opt);
    printf("  Speedup:   %.2fx\n", speedup);
    printf("  Improvement: %.1f%%\n\n", (speedup - 1.0) * 100.0);

    /* Throughput in GB/s (data read per call) */
    double bytes_per_call = (double)nb * (sizeof(block_q4_0) + sizeof(block_q8_0));
    printf("Throughput:\n");
    printf("  Original:  %.2f GB/s\n", bytes_per_call / ns_orig);
    printf("  Optimized: %.2f GB/s\n", bytes_per_call / ns_opt);

    /* ---- Sweep different sizes ---- */
    printf("\n--- Size sweep ---\n");
    printf("%8s  %10s  %10s  %8s\n", "n", "orig(ns)", "opt(ns)", "speedup");

    int sizes[] = {128, 256, 512, 1024, 2048, 4096, 8192, 16384, 32768, 65536, 131072, 0};
    for (int si = 0; sizes[si] != 0; si++) {
        int sn = sizes[si];
        int snb = sn / QK4_0;

        block_q4_0 *sx = aligned_alloc(64, snb * sizeof(block_q4_0));
        block_q8_0 *sy = aligned_alloc(64, snb * sizeof(block_q8_0));
        generate_q4_0_blocks(sx, snb);
        generate_q8_0_blocks(sy, snb);

        /* Warmup */
        float sr;
        for (int i = 0; i < 1000; i++) {
            vec_dot_q4_0_q8_0_original(sn, &sr, sx, sy);
            vec_dot_q4_0_q8_0_optimized(sn, &sr, sx, sy);
        }

        int sit = 50000;
        t0 = get_ns();
        for (int i = 0; i < sit; i++) {
            vec_dot_q4_0_q8_0_original(sn, &sr, sx, sy);
            __asm__ volatile("" :: "r"(sr));
        }
        t1 = get_ns();
        double sno = (double)(t1 - t0) / sit;

        t0 = get_ns();
        for (int i = 0; i < sit; i++) {
            vec_dot_q4_0_q8_0_optimized(sn, &sr, sx, sy);
            __asm__ volatile("" :: "r"(sr));
        }
        t1 = get_ns();
        double snopt = (double)(t1 - t0) / sit;

        printf("%8d  %10.1f  %10.1f  %7.2fx\n", sn, sno, snopt, sno/snopt);

        free(sx);
        free(sy);
    }

    free(x);
    free(y);
    return 0;
}
