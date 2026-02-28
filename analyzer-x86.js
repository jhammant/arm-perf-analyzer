#!/usr/bin/env node
/**
 * x86 Performance Analyzer — DSB/OpCache analysis, decode bottleneck detection,
 * loop fission suggestions, and Intel/AMD PMU event interpretation.
 *
 * References:
 * - Intel® 64 and IA-32 Architectures Optimization Reference Manual (Order No. 248966)
 * - Agner Fog's microarchitecture manual: https://agner.org/optimize/
 * - Agner Fog's instruction tables: https://agner.org/optimize/instruction_tables.pdf
 * - Intel Top-Down Microarchitecture Analysis: https://www.intel.com/content/www/us/en/docs/vtune-profiler/cookbook/current/top-down-microarchitecture-analysis-method.html
 */

const fs = require('fs');
const path = require('path');

const resultsDir = process.argv[2];
const vendor = (process.argv[3] || 'intel').toLowerCase();

if (!resultsDir) {
  console.error('Usage: node analyzer-x86.js <results-dir> [intel|amd]');
  process.exit(1);
}

// ═══════════════════════════════════════════════════════════════════════════════
// CPU Microarchitecture Profiles
// ═══════════════════════════════════════════════════════════════════════════════

const INTEL_SKYLAKE = {
  name: 'Intel Skylake/Cascade Lake+',
  vendor: 'intel',
  decodeWidth: 4,            // 4 decoders (1 complex + 3 simple), or 5 with micro-op cache
  // Actually: 5-wide rename/allocate, 6-wide DSB delivery, 4-wide MITE decode
  dsbDeliveryWidth: 6,       // DSB delivers up to 6 uops/cycle
  miteDecodeWidth: 4,        // MITE (legacy decode) = 4 uops/cycle (1+1+1+1 or complex decoder)
  issueWidth: 8,             // 8 execution ports (SKL)
  retireWidth: 4,            // 4 uops/cycle retire (actually ~6 in SKL+)
  robSize: 224,              // Skylake ROB
  // DSB (Decoded Stream Buffer) / uop cache
  dsbSets: 32,               // 32 sets
  dsbWays: 8,                // 8 ways
  dsbUopsPerWay: 6,          // up to 6 uops per way
  dsbMaxUops: 1536,          // 32 × 8 × 6 = 1536 uops (theoretical max)
  dsbEffectiveUops: 4096,    // ~4K uops effective capacity for typical code
  dsbLineBoundary: 32,       // DSB works on 32-byte regions aligned to 32B boundaries
  // LSD (Loop Stream Detector)
  lsdMaxUops: 64,            // Disabled on some steppings due to errata; 64 when active
  lsdDisabled: true,         // Disabled on Skylake via microcode; re-enabled on some later CPUs
  // Cache
  l1iSize: 32 * 1024,
  l1dSize: 32 * 1024,
  l2Size: 256 * 1024,
  l3SizePerCore: 1.375 * 1024 * 1024,
  l1iLatency: 1,             // Pipe stages to detect miss
  l1dLatency: 4,
  l2Latency: 12,
  l3Latency: 42,
  branchMisPenalty: 15,      // ~14-17 cycles
  // Macro-op fusion (Agner Fog §9.2, Intel Opt Manual §3.4.2.2)
  fusionPairs: [
    'CMP+Jcc', 'TEST+Jcc',   // Always fuse
    'ADD+Jcc', 'SUB+Jcc',    // Fuse in many cases
    'AND+Jcc',               // Fuses with some Jcc
    'INC+Jcc', 'DEC+Jcc',   // Fuse on Sandybridge+
  ],
  // CISC decode: complex instructions decoded by decoder 0 only (up to 4 uops),
  // instructions >4 uops use microcode sequencer (MS)
  complexDecoderMaxUops: 4,
  msThreshold: 4,            // Instructions producing >4 uops go to MS ROM
  decoderWakeupCycles: 0,    // No explicit wake-up on modern Intel (pipeline is always ready)
  // but DSB→MITE switch costs ~5 cycles penalty
  dsb2mitePenaltyCycles: 5,
};

const AMD_ZEN3 = {
  name: 'AMD Zen 3/Zen 4',
  vendor: 'amd',
  decodeWidth: 4,            // 4-wide decode
  opCacheDeliveryWidth: 8,   // Op Cache delivers up to 8 macro-ops/cycle (Zen 3)
  miteDecodeWidth: 4,        // Legacy decode = 4 instructions/cycle
  issueWidth: 6,             // 6-wide dispatch to execution units
  retireWidth: 8,            // 8 macro-ops/cycle retire
  robSize: 256,              // Zen 3
  // Op Cache (AMD's equivalent of Intel's DSB)
  opCacheEntries: 4096,      // 4K macro-op entries (Zen 3)
  opCacheMaxOpsPerEntry: 2,  // Each entry holds up to 2 macro-ops
  opCacheEffectiveOps: 6144, // ~6K macro-ops effective (Zen 3), 6.75K (Zen 4)
  opCacheLineBoundary: 64,   // Op cache works on 64-byte fetch blocks
  // Cache
  l1iSize: 32 * 1024,
  l1dSize: 32 * 1024,
  l2Size: 512 * 1024,
  l3SizePerCore: 4 * 1024 * 1024,  // Zen 3: 32MB / 8 cores
  l1iLatency: 1,
  l1dLatency: 4,
  l2Latency: 12,
  l3Latency: 40,
  branchMisPenalty: 13,      // ~11-18 cycles depending on pipeline depth
  fusionPairs: [
    'CMP+Jcc', 'TEST+Jcc',
    // AMD fuses fewer pairs than Intel
  ],
  complexDecoderMaxUops: 2,  // AMD fast-path: up to 2 macro-ops; >2 = microcode
  msThreshold: 2,
};

const PROFILES = { intel: INTEL_SKYLAKE, amd: AMD_ZEN3 };

// ═══════════════════════════════════════════════════════════════════════════════
// Known micro-op counts (from Agner Fog's instruction tables)
// Used for loop body size estimation when annotation data is available
// ═══════════════════════════════════════════════════════════════════════════════

const INTEL_UOP_TABLE = {
  // Instruction → uops (Skylake)
  'nop': 0, 'NOP': 0,           // Eliminated
  'mov': 1, 'MOV': 1,           // Register-register (may be eliminated by rename)
  'add': 1, 'ADD': 1,
  'sub': 1, 'SUB': 1,
  'and': 1, 'AND': 1,
  'or': 1, 'OR': 1,
  'xor': 1, 'XOR': 1,
  'cmp': 1, 'CMP': 1,
  'test': 1, 'TEST': 1,
  'inc': 1, 'INC': 1,
  'dec': 1, 'DEC': 1,
  'lea': 1, 'LEA': 1,
  'shl': 1, 'SHL': 1,
  'shr': 1, 'SHR': 1,
  'sar': 1, 'SAR': 1,
  'jmp': 1, 'JMP': 1,
  'jcc': 1,                      // Any conditional jump
  'je': 1, 'JE': 1, 'jne': 1, 'JNE': 1,
  'jl': 1, 'JL': 1, 'jg': 1, 'JG': 1,
  'jle': 1, 'JLE': 1, 'jge': 1, 'JGE': 1,
  'ja': 1, 'JA': 1, 'jb': 1, 'JB': 1,
  'jae': 1, 'JAE': 1, 'jbe': 1, 'JBE': 1,
  'call': 2, 'CALL': 2,         // Micro-fused: push + jump
  'ret': 1, 'RET': 1,
  'push': 1, 'PUSH': 1,         // Micro-fused: store + sub RSP (on port 2/3+7)
  'pop': 1, 'POP': 1,           // Micro-fused: load + add RSP
  'imul': 1, 'IMUL': 1,         // reg,reg = 1 uop; reg,mem = 1 fused; 3-operand varies
  'mul': 2, 'MUL': 2,           // MUL r64 = 2 uops
  'div': 35, 'DIV': 35,         // DIV r64 = ~35 uops (microcode)
  'idiv': 40, 'IDIV': 40,       // IDIV r64 = ~40 uops (microcode)
  // SIMD (SSE/AVX)
  'movaps': 1, 'movups': 1, 'movdqa': 1, 'movdqu': 1,
  'addps': 1, 'addpd': 1, 'addss': 1, 'addsd': 1,
  'mulps': 1, 'mulpd': 1, 'mulss': 1, 'mulsd': 1,
  'vaddps': 1, 'vaddpd': 1, 'vmulps': 1, 'vmulpd': 1,
  'vfmadd132ps': 1, 'vfmadd213ps': 1, 'vfmadd231ps': 1,  // FMA = 1 uop
  'vfmadd132pd': 1, 'vfmadd213pd': 1, 'vfmadd231pd': 1,
  // String ops (microcode)
  'rep': 0, 'REP': 0,           // Prefix, counted with the instruction
  'movsb': 5, 'MOVSB': 5,       // REP MOVSB = variable, but setup is ~5
  'stosb': 5, 'STOSB': 5,
  // Misc complex
  'cpuid': 20, 'CPUID': 20,     // ~20+ uops
  'syscall': 10, 'SYSCALL': 10, // ~10+ uops
};

// ═══════════════════════════════════════════════════════════════════════════════
// Parser
// ═══════════════════════════════════════════════════════════════════════════════

function parsePerfStat(file) {
  if (!fs.existsSync(file)) return {};
  const text = fs.readFileSync(file, 'utf8');
  const counters = {};

  for (const line of text.split('\n')) {
    // "  1,234,567      event_name"
    const match = line.match(/^\s*([\d,]+)\s+(\S+)/);
    if (match) {
      const value = parseInt(match[1].replace(/,/g, ''), 10);
      const name = match[2];
      if (!isNaN(value)) counters[name] = value;
    }
    // IPC
    const ipcMatch = line.match(/#\s+([\d.]+)\s+insn per cycle/);
    if (ipcMatch) counters['_ipc'] = parseFloat(ipcMatch[1]);
    // Stall %
    const stallMatch = line.match(/#\s+([\d.]+)%\s+(frontend|backend) cycles idle/);
    if (stallMatch) counters[`_${stallMatch[2]}_stall_pct`] = parseFloat(stallMatch[1]);
  }
  return counters;
}

function parseTopDown(file) {
  if (!fs.existsSync(file)) return null;
  const text = fs.readFileSync(file, 'utf8');
  const td = {};
  // Look for lines like: "retiring  bad spec  fe bound  be bound"
  // Or newer format: "30.2%  retiring  5.1%  bad speculation  40.3%  frontend bound  24.4%  backend bound"
  for (const line of text.split('\n')) {
    const pctMatch = line.match(/([\d.]+)%\s+(retiring|bad\s*spec(?:ulation)?|fe(?:_|\s*)bound|frontend\s*bound|be(?:_|\s*)bound|backend\s*bound)/gi);
    if (pctMatch) {
      for (const m of line.matchAll(/([\d.]+)%?\s+(retiring|bad[\s_]*spec(?:ulation)?|fe(?:_|\s*)bound|frontend[\s_]*bound|be(?:_|\s*)bound|backend[\s_]*bound)/gi)) {
        const val = parseFloat(m[1]);
        const key = m[2].toLowerCase().replace(/[\s_]+/g, '_');
        if (key.includes('retiring')) td.retiring = val;
        else if (key.includes('bad')) td.bad_speculation = val;
        else if (key.includes('fe') || key.includes('frontend')) td.frontend_bound = val;
        else if (key.includes('be') || key.includes('backend')) td.backend_bound = val;
      }
    }
  }
  return Object.keys(td).length > 0 ? td : null;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Analysis Engine
// ═══════════════════════════════════════════════════════════════════════════════

function analyze(counters, frontendCounters, topDown, cpu) {
  const report = [];
  const issues = [];
  const suggestions = [];

  const cycles = counters.cycles || 0;
  const instructions = counters.instructions || 0;
  const ipc = counters._ipc || (cycles > 0 ? instructions / cycles : 0);
  const frontendStall = counters._frontend_stall_pct || 0;
  const backendStall = counters._backend_stall_pct || 0;

  // ── Header ──
  report.push('# x86 Performance Analysis Report');
  report.push('');
  report.push(`**CPU Profile:** ${cpu.name}`);
  report.push(`**Cycles:** ${cycles.toLocaleString()}`);
  report.push(`**Instructions:** ${instructions.toLocaleString()}`);
  report.push(`**IPC:** ${ipc.toFixed(2)}`);
  report.push('');

  // ══════════════════════════════════════════════════════════════════════════
  // Top-Down Analysis (Intel)
  // ══════════════════════════════════════════════════════════════════════════

  if (topDown) {
    report.push('## Top-Down Microarchitecture Analysis');
    report.push('');
    report.push('| Category | % of Pipeline Slots |');
    report.push('|----------|-------------------|');
    if (topDown.retiring != null) report.push(`| ✅ Retiring | ${topDown.retiring.toFixed(1)}% |`);
    if (topDown.bad_speculation != null) report.push(`| ❌ Bad Speculation | ${topDown.bad_speculation.toFixed(1)}% |`);
    if (topDown.frontend_bound != null) report.push(`| 🔴 Frontend Bound | ${topDown.frontend_bound.toFixed(1)}% |`);
    if (topDown.backend_bound != null) report.push(`| 🟠 Backend Bound | ${topDown.backend_bound.toFixed(1)}% |`);
    report.push('');

    if (topDown.retiring != null && topDown.retiring < 30) {
      issues.push({ severity: 'critical', area: 'Top-Down', msg: `Only ${topDown.retiring.toFixed(1)}% of pipeline slots are retiring useful work` });
    }

    if (topDown.frontend_bound > 30) {
      issues.push({ severity: 'critical', area: 'Frontend Bound', msg: `${topDown.frontend_bound.toFixed(1)}% frontend bound — major instruction supply bottleneck` });
    } else if (topDown.frontend_bound > 15) {
      issues.push({ severity: 'high', area: 'Frontend Bound', msg: `${topDown.frontend_bound.toFixed(1)}% frontend bound` });
    }

    if (topDown.backend_bound > 40) {
      issues.push({ severity: 'critical', area: 'Backend Bound', msg: `${topDown.backend_bound.toFixed(1)}% backend bound — execution/memory bottleneck` });
    } else if (topDown.backend_bound > 25) {
      issues.push({ severity: 'high', area: 'Backend Bound', msg: `${topDown.backend_bound.toFixed(1)}% backend bound` });
    }

    if (topDown.bad_speculation > 15) {
      issues.push({ severity: 'high', area: 'Bad Speculation', msg: `${topDown.bad_speculation.toFixed(1)}% bad speculation — branch mispredictions or machine clears` });
    }
    report.push('');
  }

  // ══════════════════════════════════════════════════════════════════════════
  // DSB / OpCache Analysis (the main event)
  // ══════════════════════════════════════════════════════════════════════════

  report.push('## Decoded Stream Buffer (DSB) / OpCache Analysis');
  report.push('');

  if (vendor === 'intel') {
    const dsbUops = frontendCounters['idq.dsb_uops'] || 0;
    const miteUops = frontendCounters['idq.mite_uops'] || 0;
    const msUops = frontendCounters['idq.ms_uops'] || 0;
    const totalFrontendUops = dsbUops + miteUops + msUops;

    const dsbHitRate = totalFrontendUops > 0 ? (dsbUops / totalFrontendUops * 100) : 0;
    const miteRate = totalFrontendUops > 0 ? (miteUops / totalFrontendUops * 100) : 0;
    const msRate = totalFrontendUops > 0 ? (msUops / totalFrontendUops * 100) : 0;

    const dsb2miteSwitches = frontendCounters['dsb2mite_switches.penalty_cycles'] || 0;
    const dsb2mitePct = cycles > 0 ? (dsb2miteSwitches / cycles * 100) : 0;

    const uopsNotDelivered = frontendCounters['idq_uops_not_delivered.core'] || 0;
    const uopsIssued = frontendCounters['uops_issued.any'] || 0;
    const uopsRetired = frontendCounters['uops_retired.retire_slots'] || frontendCounters['uops_retired.all'] || 0;

    report.push('### Uop Delivery Source Breakdown');
    report.push('');
    report.push(`| Source | Uops | % of Total | Verdict |`);
    report.push(`|--------|------|-----------|---------|`);
    report.push(`| **DSB** (uop cache) | ${dsbUops.toLocaleString()} | ${dsbHitRate.toFixed(1)}% | ${dsbHitRate >= 80 ? '✅ Good' : dsbHitRate >= 50 ? '⚠️ Suboptimal' : '🔴 Poor'} |`);
    report.push(`| **MITE** (legacy decode) | ${miteUops.toLocaleString()} | ${miteRate.toFixed(1)}% | ${miteRate <= 10 ? '✅' : miteRate <= 30 ? '⚠️' : '🔴'} |`);
    report.push(`| **MS** (microcode) | ${msUops.toLocaleString()} | ${msRate.toFixed(1)}% | ${msRate <= 5 ? '✅' : msRate <= 15 ? '⚠️' : '🔴'} |`);
    report.push('');

    report.push(`**DSB→MITE switch penalty:** ${dsb2miteSwitches.toLocaleString()} cycles (${dsb2mitePct.toFixed(2)}% of total)`);
    report.push(`**Uops not delivered:** ${uopsNotDelivered.toLocaleString()} (frontend starvation slots)`);
    if (uopsIssued > 0) {
      report.push(`**Uops issued:** ${uopsIssued.toLocaleString()}`);
    }
    if (uopsRetired > 0) {
      report.push(`**Uops retired:** ${uopsRetired.toLocaleString()}`);
      if (uopsIssued > 0) {
        const speculationWaste = ((uopsIssued - uopsRetired) / uopsIssued * 100);
        if (speculationWaste > 5) {
          report.push(`**Speculation waste:** ${speculationWaste.toFixed(1)}% of issued uops were thrown away`);
        }
      }
    }
    report.push('');

    // ── DSB Hit Rate Analysis ──
    if (dsbHitRate < 50 && totalFrontendUops > 0) {
      issues.push({
        severity: 'critical',
        area: 'DSB',
        msg: `DSB hit rate only ${dsbHitRate.toFixed(1)}% — most uops coming from legacy MITE decoder`
      });
      suggestions.push({
        area: 'DSB / Uop Cache Optimization',
        fixes: [
          `Intel DSB holds ~1536 uops (32 sets × 8 ways × 6 uops/way) and works on 32-byte aligned regions`,
          `Each 32-byte code region maps to one DSB set — if a 32B region requires >6 uops, it can't be cached in DSB`,
          `**Reduce code size in hot loops:**`,
          `  - Use shorter instruction encodings (e.g., 32-bit operands instead of 64-bit when possible)`,
          `  - Prefer register operands over memory (avoids longer ModRM/SIB encodings)`,
          `  - Compiler flag: -Os or -O2 (not -O3) can produce smaller code that fits DSB better`,
          `**Align loop entries to 32-byte boundaries:** \`.p2align 5\` or \`__attribute__((aligned(32))))\``,
          `  This ensures the hot loop body starts at a DSB set boundary and maximizes cache utilization`,
          `**Avoid crossing 32-byte boundaries** in the middle of fused instruction pairs`,
          `**Use -falign-loops=32** compiler flag`,
          `Ref: Intel Optimization Manual §2.5.5.2 — Decoded ICache`,
        ],
      });
    } else if (dsbHitRate < 80 && totalFrontendUops > 0) {
      issues.push({
        severity: 'high',
        area: 'DSB',
        msg: `DSB hit rate ${dsbHitRate.toFixed(1)}% — significant MITE fallback`
      });
      suggestions.push({
        area: 'DSB Hit Rate',
        fixes: [
          `Target >90% DSB hit rate for hot code paths`,
          `Check if hot loops span too many 32-byte regions`,
          `Move cold code (error handling, logging) to separate functions with __attribute__((cold))`,
          `Profile with \`perf record -e frontend_retired.dsb_miss\` to find exact DSB-miss locations`,
        ],
      });
    }

    // ── DSB→MITE Switch Analysis ──
    if (dsb2mitePct > 2) {
      issues.push({
        severity: 'high',
        area: 'DSB→MITE',
        msg: `${dsb2mitePct.toFixed(1)}% cycles lost to DSB→MITE decoder switches (~${cpu.dsb2mitePenaltyCycles} cycle penalty each)`
      });
      suggestions.push({
        area: 'DSB→MITE Switches',
        fixes: [
          `Each DSB→MITE switch costs ~${cpu.dsb2mitePenaltyCycles} cycles while the MITE decoder wakes up`,
          `This happens when execution jumps between code that IS in the DSB and code that ISN'T`,
          `Fix: ensure the entire hot path fits in DSB, or none of it does (mixed is worst case)`,
          `Avoid jump targets that alternate between DSB-cached and non-cached regions`,
          `Inline small functions called from DSB-cached loops to keep everything in the uop cache`,
        ],
      });
    }

    // ── Microcode Sequencer Analysis ──
    if (msRate > 10) {
      issues.push({
        severity: 'high',
        area: 'Microcode',
        msg: `${msRate.toFixed(1)}% of uops from microcode sequencer — complex CISC instructions`
      });
      suggestions.push({
        area: 'Microcode Sequencer',
        fixes: [
          `Instructions producing >${cpu.complexDecoderMaxUops} uops use the microcode ROM, which is slow`,
          `Common offenders: DIV/IDIV (~35-40 uops), LOOP, ENTER, LEAVE, string ops (REP MOVS)`,
          `Replace DIV with multiplication by reciprocal where possible`,
          `Replace REP MOVSB with SIMD memcpy for known sizes`,
          `Use compiler intrinsics instead of legacy string operations`,
          `Ref: Agner Fog's instruction tables for per-instruction uop counts`,
        ],
      });
    }

    // ── Frontend Starvation ──
    if (uopsNotDelivered > 0 && cycles > 0) {
      // IDQ_UOPS_NOT_DELIVERED.CORE counts slots where frontend didn't deliver uops
      // Max is 4 slots/cycle (pipeline width), so normalize
      const maxSlots = cycles * 4;  // 4-wide pipeline
      const starvationRate = (uopsNotDelivered / maxSlots * 100);
      if (starvationRate > 20) {
        issues.push({
          severity: 'critical',
          area: 'Frontend Starvation',
          msg: `${starvationRate.toFixed(1)}% of pipeline slots starved by frontend`
        });
      } else if (starvationRate > 10) {
        issues.push({
          severity: 'high',
          area: 'Frontend Starvation',
          msg: `${starvationRate.toFixed(1)}% of pipeline slots starved by frontend`
        });
      }
    }

  } else if (vendor === 'amd') {
    // ── AMD Op Cache Analysis ──
    const icHit = frontendCounters['ic_tag_hit_miss.instruction_cache_hit'] || 0;
    const icMiss = frontendCounters['ic_tag_hit_miss.instruction_cache_miss'] || 0;
    const icTotal = frontendCounters['ic_tag_hit_miss.all_instruction_cache_accesses'] || (icHit + icMiss);
    const icHitRate = icTotal > 0 ? (icHit / icTotal * 100) : 0;
    const fetchStall = frontendCounters['ic_fetch_stall.ic_stall_any'] || 0;
    const fetchStallPct = cycles > 0 ? (fetchStall / cycles * 100) : 0;
    const retOps = frontendCounters['ex_ret_ops'] || 0;

    report.push('### AMD Op Cache / Instruction Cache');
    report.push('');
    report.push(`| Metric | Value |`);
    report.push(`|--------|-------|`);
    if (icTotal > 0) {
      report.push(`| I-Cache Hit Rate | ${icHitRate.toFixed(2)}% |`);
      report.push(`| I-Cache Misses | ${icMiss.toLocaleString()} |`);
    }
    report.push(`| Fetch Stall Cycles | ${fetchStall.toLocaleString()} (${fetchStallPct.toFixed(1)}%) |`);
    if (retOps > 0) report.push(`| Retired Ops | ${retOps.toLocaleString()} |`);
    report.push('');

    report.push(`**AMD Op Cache** holds ~${cpu.opCacheEntries} entries (Zen 3), delivering up to ${cpu.opCacheDeliveryWidth} macro-ops/cycle.`);
    report.push(`Op Cache works on ${cpu.opCacheLineBoundary}-byte fetch blocks. When code doesn't fit, the 4-wide legacy decoder is used.`);
    report.push('');

    if (icTotal > 0 && icHitRate < 90) {
      issues.push({
        severity: 'high',
        area: 'AMD I-Cache',
        msg: `I-Cache hit rate ${icHitRate.toFixed(1)}% — code may exceed L1I capacity (${cpu.l1iSize/1024}KB)`
      });
    }

    if (fetchStallPct > 10) {
      issues.push({
        severity: 'critical',
        area: 'AMD Fetch',
        msg: `${fetchStallPct.toFixed(1)}% cycles stalled on instruction fetch`
      });
      suggestions.push({
        area: 'AMD Frontend / Op Cache',
        fixes: [
          `AMD Zen Op Cache holds ~4096 entries, each storing up to 2 macro-ops`,
          `When code falls out of Op Cache, the 4-wide legacy decoder takes over (half the bandwidth)`,
          `Reduce hot loop code footprint — keep loops under ~4K macro-ops`,
          `Align branch targets to 64-byte boundaries for optimal fetch`,
          `Use -O2 instead of -O3: smaller code often runs faster due to Op Cache residency`,
          `Move cold paths out of hot loops with __attribute__((cold)) or PGO`,
          `Ref: AMD Zen Software Optimization Guide §2.8 — Op Cache`,
        ],
      });
    }
  }
  report.push('');

  // ══════════════════════════════════════════════════════════════════════════
  // Cache Analysis
  // ══════════════════════════════════════════════════════════════════════════

  report.push('## Cache Hierarchy');
  report.push('');

  const l1iLoads = counters['L1-icache-loads'] || 0;
  const l1iMisses = counters['L1-icache-load-misses'] || 0;
  const l1iMissRate = l1iLoads > 0 ? (l1iMisses / l1iLoads * 100) : 0;
  const l1dLoads = counters['L1-dcache-loads'] || 0;
  const l1dMisses = counters['L1-dcache-load-misses'] || 0;
  const l1dMissRate = l1dLoads > 0 ? (l1dMisses / l1dLoads * 100) : 0;
  const cacheMisses = counters['cache-misses'] || 0;
  const cacheRefs = counters['cache-references'] || 0;
  const llcMissRate = cacheRefs > 0 ? (cacheMisses / cacheRefs * 100) : 0;

  report.push(`| Cache | Misses | Miss Rate | Note |`);
  report.push(`|-------|--------|-----------|------|`);
  report.push(`| L1I (${cpu.l1iSize/1024}KB) | ${l1iMisses.toLocaleString()} | ${l1iMissRate.toFixed(2)}% | ${l1iMissRate > 5 ? '🔴 Code too large' : l1iMissRate > 1 ? '⚠️' : '✅'} |`);
  report.push(`| L1D (${cpu.l1dSize/1024}KB) | ${l1dMisses.toLocaleString()} | ${l1dMissRate.toFixed(2)}% | ${l1dMissRate > 10 ? '🔴' : l1dMissRate > 3 ? '⚠️' : '✅'} |`);
  report.push(`| LLC | ${cacheMisses.toLocaleString()} | ${llcMissRate.toFixed(2)}% | ${llcMissRate > 20 ? '🔴' : llcMissRate > 5 ? '⚠️' : '✅'} |`);
  report.push('');

  if (l1iMissRate > 5) {
    issues.push({ severity: 'high', area: 'L1I Cache', msg: `${l1iMissRate.toFixed(1)}% I-cache miss rate — hot code exceeds ${cpu.l1iSize/1024}KB L1I` });
    suggestions.push({
      area: 'Instruction Cache',
      fixes: [
        `x86 L1I is only ${cpu.l1iSize/1024}KB — much smaller than ARM's typical 64KB`,
        `I-cache misses cause DSB/OpCache evictions AND L1I refills (double penalty)`,
        `Use Profile-Guided Optimization (PGO): gcc -fprofile-generate / -fprofile-use`,
        `PGO reorders code to keep hot paths contiguous and cold paths separate`,
        `BOLT (Binary Optimization and Layout Tool) can reorder functions post-link`,
        `Compiler: -ffunction-sections + linker --gc-sections to remove dead code`,
      ],
    });
  }

  if (l1dMissRate > 10) {
    issues.push({ severity: 'high', area: 'L1D Cache', msg: `${l1dMissRate.toFixed(1)}% D-cache miss rate` });
    suggestions.push({
      area: 'Data Cache',
      fixes: [
        `L1D is ${cpu.l1dSize/1024}KB with ${cpu.l1dLatency}-cycle hit latency, L2 miss costs ~${cpu.l2Latency} cycles`,
        `Software prefetch: _mm_prefetch((char*)ptr, _MM_HINT_T0) or __builtin_prefetch()`,
        `AoS→SoA transformation for hot fields in data-parallel code`,
        `Cache line size is 64 bytes — align critical structures with alignas(64)`,
        `Avoid pointer-chasing: use arrays/indices instead of linked lists`,
      ],
    });
  }
  report.push('');

  // ══════════════════════════════════════════════════════════════════════════
  // Branch Analysis
  // ══════════════════════════════════════════════════════════════════════════

  const branchLoads = counters['branch-loads'] || 0;
  const branchMisses = counters['branch-misses'] || 0;
  const branchMissRate = branchLoads > 0 ? (branchMisses / branchLoads * 100) : 0;

  report.push('## Branch Prediction');
  report.push(`- Miss rate: ${branchMissRate.toFixed(2)}% (${branchMisses.toLocaleString()} / ${branchLoads.toLocaleString()})`);
  report.push(`- Mispredict penalty: ~${cpu.branchMisPenalty} cycles`);

  const branchWaste = branchMisses * cpu.branchMisPenalty;
  const branchWastePct = cycles > 0 ? (branchWaste / cycles * 100) : 0;
  report.push(`- Estimated cycle waste: ${branchWaste.toLocaleString()} (${branchWastePct.toFixed(1)}% of total)`);
  report.push('');

  if (branchMissRate > 5) {
    issues.push({ severity: 'high', area: 'Branches', msg: `${branchMissRate.toFixed(1)}% miss rate — ${branchWastePct.toFixed(1)}% cycles wasted` });
    suggestions.push({
      area: 'Branch Prediction',
      fixes: [
        `Use CMOV (conditional move) instead of branches for simple conditionals`,
        `Compiler: -march=native enables branch-hint prefixes on supported CPUs`,
        `__builtin_expect() for likely/unlikely hints → compiler generates fall-through on likely path`,
        `For data-dependent branches: sort input data or use branchless algorithms`,
        `Macro-op fusion: ensure CMP/TEST immediately precedes Jcc (same cache line)`,
        `Fused pairs: ${cpu.fusionPairs.join(', ')}`,
      ],
    });
  }

  // ══════════════════════════════════════════════════════════════════════════
  // TLB Analysis
  // ══════════════════════════════════════════════════════════════════════════

  const iTlbMisses = counters['iTLB-load-misses'] || 0;
  const iTlbLoads = counters['iTLB-loads'] || 0;
  const dTlbMisses = counters['dTLB-load-misses'] || 0;
  const dTlbLoads = counters['dTLB-loads'] || 0;

  if (iTlbMisses > 0 || dTlbMisses > 0) {
    report.push('## TLB');
    const iTlbRate = iTlbLoads > 0 ? (iTlbMisses / iTlbLoads * 100) : 0;
    const dTlbRate = dTlbLoads > 0 ? (dTlbMisses / dTlbLoads * 100) : 0;
    report.push(`- iTLB miss rate: ${iTlbRate.toFixed(3)}%`);
    report.push(`- dTLB miss rate: ${dTlbRate.toFixed(3)}%`);
    report.push('');

    if (dTlbRate > 0.5) {
      issues.push({ severity: 'medium', area: 'dTLB', msg: `${dTlbRate.toFixed(2)}% dTLB miss rate` });
      suggestions.push({
        area: 'TLB',
        fixes: [
          'Enable transparent hugepages: echo always > /sys/kernel/mm/transparent_hugepage/enabled',
          'Explicit 2MB pages: mmap with MAP_HUGETLB',
          'madvise(addr, len, MADV_HUGEPAGE) for specific allocations',
        ],
      });
    }
    if (iTlbRate > 0.1) {
      issues.push({ severity: 'medium', area: 'iTLB', msg: `${iTlbRate.toFixed(3)}% iTLB miss rate — large code footprint` });
      suggestions.push({
        area: 'iTLB',
        fixes: [
          'Large code footprint is thrashing iTLB entries',
          'Use PGO + BOLT to compact hot code onto fewer pages',
          'Enable 2MB code pages (some runtimes support this)',
        ],
      });
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Loop Size / DSB Capacity Estimation
  // ══════════════════════════════════════════════════════════════════════════

  report.push('## Loop Size vs DSB Capacity');
  report.push('');
  if (vendor === 'intel') {
    report.push(`The Intel DSB caches decoded uops in 32-byte aligned regions.`);
    report.push(`Each 32-byte region can hold up to 6 uops. The DSB has 32 sets × 8 ways = 256 entries.`);
    report.push('');
    report.push('**Rules of thumb for fitting in DSB:**');
    report.push(`- A loop body spanning N 32-byte regions uses N DSB set entries`);
    report.push(`- If any 32-byte region needs >6 uops, that region falls back to MITE`);
    report.push(`- Loops up to ~1500 uops generally fit well in DSB`);
    report.push(`- Loops >2000 uops start experiencing DSB pressure`);
    report.push(`- Cross-region jumps pollute multiple DSB sets`);
    report.push('');
    report.push('**Checking if your hot loop fits in DSB:**');
    report.push('```bash');
    report.push('# Count instructions in hot loop (from perf annotate output):');
    report.push('perf annotate -s hot_function | grep -c "^\\s*[0-9a-f]"');
    report.push('');
    report.push('# Estimate uops: most x86 instructions = 1 uop,');
    report.push('# memory ops with complex addressing = 2 (micro-fused),');
    report.push('# DIV/IDIV = 20-40 uops, REP string = variable');
    report.push('```');
    report.push('');
    report.push('**When loop exceeds DSB — apply loop fission:**');
    report.push('```c');
    report.push('// BEFORE: Large loop body exceeds DSB capacity');
    report.push('for (int i = 0; i < N; i++) {');
    report.push('    compute_a(data[i]);    // Hot path: runs every iteration');
    report.push('    if (rare_condition) {');
    report.push('        handle_edge(data[i]); // Cold: runs <1% of iterations');
    report.push('    }');
    report.push('    finalize(data[i]);');
    report.push('}');
    report.push('');
    report.push('// AFTER: Split cold path out — hot loop fits in DSB');
    report.push('for (int i = 0; i < N; i++) {');
    report.push('    compute_a(data[i]);');
    report.push('    if (rare_condition) cold_indices[cold_count++] = i;');
    report.push('    finalize(data[i]);');
    report.push('}');
    report.push('for (int j = 0; j < cold_count; j++) {');
    report.push('    handle_edge(data[cold_indices[j]]);');
    report.push('}');
    report.push('```');
  } else {
    report.push(`AMD Op Cache holds ~${cpu.opCacheEntries} entries, each storing up to 2 macro-ops.`);
    report.push(`It works on 64-byte fetch blocks (vs Intel's 32-byte regions).`);
    report.push('');
    report.push('**Rules of thumb for fitting in AMD Op Cache:**');
    report.push(`- Loops up to ~4K macro-ops generally fit`);
    report.push(`- Op Cache delivers ${cpu.opCacheDeliveryWidth} ops/cycle vs ${cpu.miteDecodeWidth}/cycle from legacy decoder`);
    report.push(`- Falling out of Op Cache halves frontend bandwidth`);
    report.push(`- Same loop fission techniques apply as Intel DSB`);
  }
  report.push('');

  // ══════════════════════════════════════════════════════════════════════════
  // Macro-op Fusion
  // ══════════════════════════════════════════════════════════════════════════

  report.push('## Macro-op Fusion');
  report.push('');
  report.push(`${cpu.name} can fuse these instruction pairs into single uops:`);
  for (const pair of cpu.fusionPairs) {
    report.push(`- \`${pair}\``);
  }
  report.push('');
  report.push('**Fusion requirements (Intel):**');
  report.push('- Both instructions must be in the same 16-byte decode window');
  report.push('- The CMP/TEST must immediately precede the Jcc (no intervening instructions)');
  report.push('- On Sandybridge+, works with both register and memory operands');
  report.push('- Macro-fused pair still counts as 1 uop in DSB/ROB');
  report.push('');
  report.push('**Anti-pattern:** Avoid inserting instructions between CMP and Jcc:');
  report.push('```asm');
  report.push('; BAD — prevents fusion:');
  report.push('  cmp rax, rbx');
  report.push('  mov rcx, rdx    ; <-- breaks the CMP+JE fusion');
  report.push('  je  .target');
  report.push('');
  report.push('; GOOD — fuses into single uop:');
  report.push('  mov rcx, rdx');
  report.push('  cmp rax, rbx');
  report.push('  je  .target');
  report.push('```');
  report.push('');

  // ══════════════════════════════════════════════════════════════════════════
  // x86-specific optimization tips
  // ══════════════════════════════════════════════════════════════════════════

  report.push('## x86-Specific Optimization Notes');
  report.push('');
  report.push(`**Decode width:** ${cpu.name} decodes ${cpu.miteDecodeWidth} instructions/cycle via MITE (legacy decoder).`);
  if (vendor === 'intel') {
    report.push(`DSB (uop cache) delivers up to ${cpu.dsbDeliveryWidth} uops/cycle — 50% more bandwidth than MITE.`);
    report.push(`This is why DSB hit rate matters so much for frontend-bound code.`);
  } else {
    report.push(`Op Cache delivers up to ${cpu.opCacheDeliveryWidth} ops/cycle — 2× MITE bandwidth.`);
  }
  report.push('');
  report.push(`**ROB size:** ${cpu.robSize} entries. Long dependency chains limit ILP.`);
  report.push(`Break chains with independent accumulators and interleaved operations.`);
  report.push('');
  report.push('**CISC→RISC overhead:** x86 instructions are decoded into micro-ops (uops) internally.');
  report.push(`Instructions with >4 uops (Intel) or >2 ops (AMD) use slow microcode sequencer.`);
  report.push('Common microcode offenders: DIV, IDIV, CPUID, LOOP, ENTER, REP string ops.');
  report.push('');
  if (vendor === 'intel') {
    report.push('**Loop Stream Detector (LSD):** Disabled on many Skylake steppings (microcode errata).');
    report.push('On CPUs where active, LSD caches ~64 uops for tiny loops, bypassing DSB lookup.');
    report.push('');
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Issues Summary
  // ══════════════════════════════════════════════════════════════════════════

  report.push('## Issues Summary');
  report.push('');

  const bySeverity = { critical: [], high: [], medium: [] };
  for (const issue of issues) {
    (bySeverity[issue.severity] || []).push(issue);
  }

  let issueCount = 0;
  for (const sev of ['critical', 'high', 'medium']) {
    const icon = sev === 'critical' ? '🔴' : sev === 'high' ? '🟠' : '🟡';
    for (const issue of bySeverity[sev]) {
      report.push(`${icon} **[${issue.area}]** ${issue.msg}`);
      issueCount++;
    }
  }
  if (issueCount === 0) {
    report.push('✅ No significant issues detected.');
  }
  report.push('');

  // ══════════════════════════════════════════════════════════════════════════
  // Recommendations
  // ══════════════════════════════════════════════════════════════════════════

  if (suggestions.length > 0) {
    report.push('## Recommended Optimizations');
    report.push('');
    for (const s of suggestions) {
      report.push(`### ${s.area}`);
      for (const fix of s.fixes) {
        report.push(`- ${fix}`);
      }
      report.push('');
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // References
  // ══════════════════════════════════════════════════════════════════════════

  report.push('## References');
  report.push('');
  report.push('- [Agner Fog — Microarchitecture Manual](https://agner.org/optimize/microarchitecture.pdf)');
  report.push('- [Agner Fog — Instruction Tables](https://agner.org/optimize/instruction_tables.pdf)');
  report.push('- [Intel® 64 and IA-32 Optimization Reference Manual](https://www.intel.com/content/www/us/en/docs/architectures-software-developer-manuals/64-ia-32-architectures-optimization-manual/overview.html)');
  report.push('- [Intel Top-Down Microarchitecture Analysis](https://www.intel.com/content/www/us/en/docs/vtune-profiler/cookbook/current/top-down-microarchitecture-analysis-method.html)');
  report.push('- [AMD Software Optimization Guide for Zen Processors](https://www.amd.com/en/support/tech-docs)');
  report.push('- [BOLT — Binary Optimization and Layout Tool](https://github.com/llvm/llvm-project/tree/main/bolt)');
  report.push('');

  return report.join('\n');
}

// ── Main ────────────────────────────────────────────────────────────────────

const cpu = PROFILES[vendor] || PROFILES.intel;
const counters = parsePerfStat(path.join(resultsDir, 'perf-stat.txt'));
const frontendCounters = parsePerfStat(path.join(resultsDir, 'x86-frontend.txt'));
const topDown = parseTopDown(path.join(resultsDir, 'x86-topdown.txt'));

const report = analyze(counters, frontendCounters, topDown, cpu);
console.log(report);
