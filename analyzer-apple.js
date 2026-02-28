#!/usr/bin/env node
/**
 * Apple Silicon Performance Analyzer
 * 
 * Analysis engine for Apple M-series (M1/M2/M3/M4) microarchitecture.
 * Parses output from analyze-mac.sh (powermetrics, xctrace, sample).
 * 
 * Microarchitecture data sourced from:
 * - Dougall Johnson: https://dougallj.github.io/applecpu/firestorm.html
 * - LLVM Apple CPU scheduling models
 * - Anandtech M1 deep dive
 */

const fs = require('fs');
const path = require('path');

const resultsDir = process.argv[2];
const chipArg = process.argv[3] || 'auto'; // m1, m2, m3, m4, auto

if (!resultsDir) {
  console.error('Usage: node analyzer-apple.js <results-dir> [m1|m2|m3|m4]');
  process.exit(1);
}

// ── Apple Silicon Microarchitecture Database ────────────────────────────────

const CHIPS = {
  m1: {
    name: 'Apple M1',
    pCoreName: 'Firestorm',
    eCoreName: 'Icestorm',
    pCores: 4, eCores: 4,
    // P-core pipeline
    decodeWidth: 8,         // 8 instructions/cycle decode
    issueWidth: 9,          // ~9 micro-ops/cycle issue
    retireWidth: 8,
    robSize: 630,           // Reorder buffer entries (massive)
    // E-core pipeline
    eDecodeWidth: 4,
    eIssueWidth: 4,
    eRobSize: 96,
    // Cache hierarchy (P-core)
    l1iSize: 192 * 1024,   // 192KB L1I (P-core)
    l1dSize: 128 * 1024,   // 128KB L1D (P-core)
    l2Size: 12 * 1024 * 1024, // 12MB shared L2 (P-cluster)
    // E-core cache
    el1iSize: 128 * 1024,
    el1dSize: 64 * 1024,
    el2Size: 4 * 1024 * 1024,
    // Latencies (P-core, cycles)
    l1iLatency: 1,
    l1dLatency: 3,          // ~3 cycles
    l2Latency: 12,
    branchMisPenalty: 14,    // ~14 cycle pipeline flush
    // Loop buffer
    loopBufferEntries: 64,   // L0 loop stream detector
    // Memory
    memBandwidthGBs: 68,    // LPDDR5 bandwidth
    // Fusion
    maxFusionPerCycle: 3,    // Can fuse multiple pairs per cycle
    // Execution units (P-core)
    intALUs: 6,
    fpNEONUnits: 4,
    loadUnits: 2,
    storeUnits: 2,
    branchUnits: 2,
  },
  m2: {
    name: 'Apple M2',
    pCoreName: 'Avalanche',
    eCoreName: 'Blizzard',
    pCores: 4, eCores: 4,
    decodeWidth: 8, issueWidth: 9, retireWidth: 8, robSize: 630,
    eDecodeWidth: 4, eIssueWidth: 4, eRobSize: 96,
    l1iSize: 192 * 1024, l1dSize: 128 * 1024, l2Size: 16 * 1024 * 1024,
    el1iSize: 128 * 1024, el1dSize: 64 * 1024, el2Size: 4 * 1024 * 1024,
    l1iLatency: 1, l1dLatency: 3, l2Latency: 12, branchMisPenalty: 14,
    loopBufferEntries: 64,
    memBandwidthGBs: 100,
    maxFusionPerCycle: 3,
    intALUs: 6, fpNEONUnits: 4, loadUnits: 2, storeUnits: 2, branchUnits: 2,
  },
  m3: {
    name: 'Apple M3',
    pCoreName: 'Everest',
    eCoreName: 'Sawtooth',
    pCores: 4, eCores: 4,
    decodeWidth: 8, issueWidth: 9, retireWidth: 8, robSize: 630,
    eDecodeWidth: 4, eIssueWidth: 4, eRobSize: 128,
    l1iSize: 192 * 1024, l1dSize: 128 * 1024, l2Size: 16 * 1024 * 1024,
    el1iSize: 128 * 1024, el1dSize: 64 * 1024, el2Size: 4 * 1024 * 1024,
    l1iLatency: 1, l1dLatency: 3, l2Latency: 12, branchMisPenalty: 14,
    loopBufferEntries: 64,
    memBandwidthGBs: 100,
    maxFusionPerCycle: 3,
    intALUs: 6, fpNEONUnits: 4, loadUnits: 2, storeUnits: 2, branchUnits: 2,
  },
  m4: {
    name: 'Apple M4',
    pCoreName: 'Everest (enhanced)',
    eCoreName: 'Sawtooth (enhanced)',
    pCores: 4, eCores: 6,
    decodeWidth: 8, issueWidth: 10, retireWidth: 8, robSize: 700,
    eDecodeWidth: 4, eIssueWidth: 5, eRobSize: 128,
    l1iSize: 192 * 1024, l1dSize: 128 * 1024, l2Size: 16 * 1024 * 1024,
    el1iSize: 128 * 1024, el1dSize: 64 * 1024, el2Size: 4 * 1024 * 1024,
    l1iLatency: 1, l1dLatency: 3, l2Latency: 11, branchMisPenalty: 13,
    loopBufferEntries: 64,
    memBandwidthGBs: 120,
    maxFusionPerCycle: 3,
    intALUs: 6, fpNEONUnits: 4, loadUnits: 3, storeUnits: 2, branchUnits: 2,
  },
};

// ── Apple Silicon Fusion Rules ──────────────────────────────────────────────
// Sources: Dougall Johnson reverse engineering, LLVM scheduling model

const FUSION_RULES = {
  // Standard ARM fusion (also done by N1)
  standard: [
    { first: /^CMP\b/, second: /^B\.(EQ|NE|LT|GT|LE|GE|CS|CC|HI|LS|MI|PL|VS|VC|AL)\b/i, name: 'CMP+B.cond' },
    { first: /^CMN\b/, second: /^B\.(EQ|NE|LT|GT|LE|GE|CS|CC|HI|LS|MI|PL|VS|VC|AL)\b/i, name: 'CMN+B.cond' },
    { first: /^TST\b/, second: /^B\.(EQ|NE|LT|GT|LE|GE|CS|CC|HI|LS|MI|PL|VS|VC|AL)\b/i, name: 'TST+B.cond' },
    { first: /^ADDS\b/, second: /^B\.(EQ|NE|LT|GT|LE|GE|CS|CC|HI|LS|MI|PL|VS|VC|AL)\b/i, name: 'ADDS+B.cond' },
    { first: /^SUBS\b/, second: /^B\.(EQ|NE|LT|GT|LE|GE|CS|CC|HI|LS|MI|PL|VS|VC|AL)\b/i, name: 'SUBS+B.cond' },
  ],
  // Apple-specific fusion (not done on standard ARM cores)
  appleSpecific: [
    { first: /^ADD\b/, second: /^B\.(EQ|NE|LT|GT|LE|GE|CS|CC|HI|LS|MI|PL|VS|VC|AL)\b/i, name: 'ADD+B.cond' },
    { first: /^SUB\b/, second: /^B\.(EQ|NE|LT|GT|LE|GE|CS|CC|HI|LS|MI|PL|VS|VC|AL)\b/i, name: 'SUB+B.cond' },
    // Address generation fusion — Apple specific
    { first: /^ADRP\b/, second: /^ADD\b/, name: 'ADRP+ADD (addr gen fusion)' },
    { first: /^ADRP\b/, second: /^LDR\b/, name: 'ADRP+LDR (addr gen fusion)' },
    // Crypto fusion
    { first: /^AES[ED]\b/i, second: /^AESMC\b|^AESIMC\b/i, name: 'AES+AESMC (crypto fusion)' },
  ],
};

// ── Known Cycle Counts (from Dougall Johnson) ───────────────────────────────
// https://dougallj.github.io/applecpu/firestorm.html

const FIRESTORM_LATENCIES = {
  // Integer
  'ADD':  { latency: 1, throughput: 6 },   // 6 ALUs can issue ADD
  'SUB':  { latency: 1, throughput: 6 },
  'MUL':  { latency: 3, throughput: 2 },   // 2 multiplier units
  'MADD': { latency: 3, throughput: 2 },
  'SDIV': { latency: 7, throughput: 1 },   // variable, ~7 for 32-bit
  'UDIV': { latency: 7, throughput: 1 },
  'CMP':  { latency: 1, throughput: 6 },
  'AND':  { latency: 1, throughput: 6 },
  'ORR':  { latency: 1, throughput: 6 },
  'EOR':  { latency: 1, throughput: 6 },
  'LSL':  { latency: 1, throughput: 4 },
  'LSR':  { latency: 1, throughput: 4 },
  'ASR':  { latency: 1, throughput: 4 },
  // Load/Store
  'LDR':  { latency: 3, throughput: 2 },   // L1D hit
  'LDP':  { latency: 3, throughput: 2 },
  'STR':  { latency: 0, throughput: 2 },   // fire and forget
  'STP':  { latency: 0, throughput: 2 },
  // NEON/FP
  'FADD': { latency: 3, throughput: 4 },
  'FMUL': { latency: 4, throughput: 4 },
  'FMADD':{ latency: 4, throughput: 4 },   // fused multiply-add
  'FMLA': { latency: 4, throughput: 4 },   // NEON FMA
  // Crypto
  'AESE': { latency: 3, throughput: 2 },
  'AESD': { latency: 3, throughput: 2 },
  'AESMC':{ latency: 2, throughput: 2 },   // fuses with AES when adjacent
  // Branch
  'B':    { latency: 0, throughput: 2 },
  'BL':   { latency: 0, throughput: 2 },
  'RET':  { latency: 0, throughput: 2 },
  'CBZ':  { latency: 0, throughput: 2 },
  'CBNZ': { latency: 0, throughput: 2 },
};

// ── Parse powermetrics output ───────────────────────────────────────────────

function parsePowermetrics(file) {
  if (!fs.existsSync(file)) return null;
  const text = fs.readFileSync(file, 'utf8');
  const data = {
    cpuPower: null,
    gpuPower: null,
    packagePower: null,
    pCoreFreqMHz: null,
    eCoreFreqMHz: null,
    pCoreResidency: null,
    eCoreResidency: null,
    instructions: null,
    cycles: null,
  };

  // CPU Power: 5432 mW
  let m = text.match(/CPU Power:\s+([\d.]+)\s*mW/i);
  if (m) data.cpuPower = parseFloat(m[1]);

  m = text.match(/GPU Power:\s+([\d.]+)\s*mW/i);
  if (m) data.gpuPower = parseFloat(m[1]);

  m = text.match(/Package Power:\s+([\d.]+)\s*mW/i);
  if (m) data.packagePower = parseFloat(m[1]);

  // P-cluster frequency
  m = text.match(/P-Cluster.*?Active Frequency.*?:\s+([\d]+)\s*MHz/is);
  if (m) data.pCoreFreqMHz = parseInt(m[1]);

  // E-cluster frequency
  m = text.match(/E-Cluster.*?Active Frequency.*?:\s+([\d]+)\s*MHz/is);
  if (m) data.eCoreFreqMHz = parseInt(m[1]);

  // Instructions retired / cycles (from CPU_CLK_UNHALTED.THREAD etc.)
  m = text.match(/INST_ALL\s*=\s*([\d]+)/i);
  if (m) data.instructions = parseInt(m[1]);

  m = text.match(/CORE_ACTIVE_CYCLE\s*=\s*([\d]+)/i);
  if (m) data.cycles = parseInt(m[1]);

  return data;
}

// ── Parse sample/xctrace top functions ──────────────────────────────────────

function parseTopFunctions(file) {
  if (!fs.existsSync(file)) return [];
  const text = fs.readFileSync(file, 'utf8');
  const funcs = [];
  
  // Parse "sample" output: <count> <symbol>
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(\S+)/);
    if (m) {
      funcs.push({ samples: parseInt(m[1]), name: m[2] });
    }
  }
  
  return funcs.sort((a, b) => b.samples - a.samples);
}

// ── Parse timing results ────────────────────────────────────────────────────

function parseTimingResults(file) {
  if (!fs.existsSync(file)) return null;
  const text = fs.readFileSync(file, 'utf8');
  const data = {};
  
  for (const line of text.split('\n')) {
    // wall_time_ns: 123456789
    const m = line.match(/^(\w+):\s*([\d.]+)/);
    if (m) data[m[1]] = parseFloat(m[2]);
  }
  
  return data;
}

// ── Detect chip from meta.json or system info ───────────────────────────────

function detectChip(resultsDir) {
  if (chipArg !== 'auto' && CHIPS[chipArg]) return CHIPS[chipArg];
  
  try {
    const meta = JSON.parse(fs.readFileSync(path.join(resultsDir, 'meta.json'), 'utf8'));
    const cpu = (meta.cpu || '').toLowerCase();
    if (cpu.includes('m4')) return CHIPS.m4;
    if (cpu.includes('m3')) return CHIPS.m3;
    if (cpu.includes('m2')) return CHIPS.m2;
    if (cpu.includes('m1')) return CHIPS.m1;
  } catch {}
  
  // Default to M4 (Jon's MacBook Air)
  return CHIPS.m4;
}

// ── Main Analysis ───────────────────────────────────────────────────────────

function analyze(chip, powerData, topFunctions, timing) {
  const report = [];
  const issues = [];
  const suggestions = [];

  report.push('# Apple Silicon Performance Analysis');
  report.push('');
  report.push(`**Chip:** ${chip.name} (${chip.pCores}P + ${chip.eCores}E cores)`);
  report.push(`**P-core:** ${chip.pCoreName} — ${chip.decodeWidth}-wide decode, ${chip.issueWidth}-wide issue, ROB: ${chip.robSize}`);
  report.push(`**E-core:** ${chip.eCoreName} — ${chip.eDecodeWidth}-wide decode`);
  report.push('');

  // ── Power & Frequency ──
  if (powerData) {
    report.push('## Power & Frequency');
    if (powerData.cpuPower) report.push(`- CPU Power: ${powerData.cpuPower.toFixed(0)} mW`);
    if (powerData.packagePower) report.push(`- Package Power: ${powerData.packagePower.toFixed(0)} mW`);
    if (powerData.pCoreFreqMHz) report.push(`- P-cluster freq: ${powerData.pCoreFreqMHz} MHz`);
    if (powerData.eCoreFreqMHz) report.push(`- E-cluster freq: ${powerData.eCoreFreqMHz} MHz`);
    
    if (powerData.instructions && powerData.cycles) {
      const ipc = powerData.instructions / powerData.cycles;
      report.push(`- IPC: ${ipc.toFixed(2)} (theoretical max: ${chip.decodeWidth}.0)`);
      report.push(`- Instructions: ${powerData.instructions.toLocaleString()}`);
      report.push(`- Cycles: ${powerData.cycles.toLocaleString()}`);
      
      const efficiency = (ipc / chip.decodeWidth * 100);
      report.push(`- Decode efficiency: ${efficiency.toFixed(1)}%`);
      
      if (ipc < 2.0) {
        issues.push({ severity: 'critical', area: 'IPC', msg: `IPC ${ipc.toFixed(2)} is very low for ${chip.name} (max ${chip.decodeWidth}.0)` });
      } else if (ipc < 4.0) {
        issues.push({ severity: 'high', area: 'IPC', msg: `IPC ${ipc.toFixed(2)} — ${chip.name} can do ${chip.decodeWidth}-wide, significant room to improve` });
      } else if (ipc < 6.0) {
        issues.push({ severity: 'medium', area: 'IPC', msg: `IPC ${ipc.toFixed(2)} — good but ${chip.name}'s 8-wide decode has more headroom` });
      }
    }
    report.push('');
  }

  // ── Timing Analysis (fallback when no HW counters) ──
  if (timing) {
    report.push('## Timing Analysis');
    if (timing.wall_time_ns) {
      const ms = timing.wall_time_ns / 1e6;
      report.push(`- Wall time: ${ms.toFixed(2)} ms`);
    }
    if (timing.user_time_ns) {
      const ms = timing.user_time_ns / 1e6;
      report.push(`- User time: ${ms.toFixed(2)} ms`);
    }
    if (timing.sys_time_ns) {
      const ms = timing.sys_time_ns / 1e6;
      report.push(`- System time: ${ms.toFixed(2)} ms`);
    }
    report.push('');
  }

  // ── Top Functions ──
  if (topFunctions.length > 0) {
    const totalSamples = topFunctions.reduce((s, f) => s + f.samples, 0);
    report.push('## Hotspots');
    report.push('');
    const top10 = topFunctions.slice(0, 10);
    for (const f of top10) {
      const pct = (f.samples / totalSamples * 100).toFixed(1);
      report.push(`- **${pct}%** \`${f.name}\``);
    }
    report.push('');
  }

  // ── Apple Silicon-Specific Guidance ──
  report.push('## Apple Silicon Optimization Opportunities');
  report.push('');
  
  report.push('### Macro-op Fusion');
  report.push(`${chip.name} fuses up to ${chip.maxFusionPerCycle} instruction pairs/cycle (vs 1 on Neoverse-N1).`);
  report.push('');
  report.push('**Standard fusion (also on ARM reference):**');
  for (const r of FUSION_RULES.standard) report.push(`- ${r.name}`);
  report.push('');
  report.push('**Apple-specific fusion (not on N1/N2):**');
  for (const r of FUSION_RULES.appleSpecific) report.push(`- ${r.name}`);
  report.push('');
  report.push('> Use `fusion-check.js` to analyze your binary for fusion opportunities.');
  report.push('');

  report.push('### Cache Hierarchy');
  report.push(`P-core L1I: ${chip.l1iSize / 1024}KB (3× larger than Neoverse-N1's 64KB)`);
  report.push(`P-core L1D: ${chip.l1dSize / 1024}KB (2× larger than N1's 64KB)`);
  report.push(`L2: ${chip.l2Size / (1024*1024)}MB shared per cluster`);
  report.push('');
  report.push('With 192KB L1I, code size pressure is much less of a concern than on N1.');
  report.push('Focus optimization on data layout and memory bandwidth instead.');
  report.push('');

  report.push('### ROB & Instruction-Level Parallelism');
  report.push(`ROB: ${chip.robSize} entries (vs 128 on N1 — ${(chip.robSize / 128).toFixed(0)}× larger).`);
  report.push('This means:');
  report.push('- Much more tolerance for cache miss latency (can keep executing ahead)');
  report.push('- Long dependency chains are less harmful than on smaller cores');
  report.push('- But: maximize independent operations to fill the wide backend');
  report.push('');

  report.push('### Loop Buffer / Loop Stream Detector');
  report.push(`${chip.name} has a ~${chip.loopBufferEntries}-entry loop buffer (L0 cache).`);
  report.push('Tight loops that fit in the loop buffer bypass fetch/decode entirely.');
  report.push('Keep hot inner loops under ~64 instructions for maximum throughput.');
  report.push('');

  report.push('### NEON / AMX');
  report.push(`${chip.fpNEONUnits} NEON/FP units on P-cores — 4× throughput vs typical 2-unit ARM cores.`);
  report.push('Apple\'s AMX coprocessor accelerates matrix ops (used by Accelerate.framework).');
  report.push('For ML workloads: prefer vDSP/BLAS from Accelerate over hand-rolled NEON.');
  report.push('');

  report.push('### Memory Bandwidth');
  report.push(`Unified memory bandwidth: ~${chip.memBandwidthGBs} GB/s.`);
  report.push('No CPU↔GPU copy overhead — zero-copy between CPU and GPU.');
  report.push('For bandwidth-bound workloads, ensure sequential access patterns.');
  report.push('');

  // ── Key Cycle Counts Reference ──
  report.push('### Key Cycle Counts (P-core)');
  report.push('');
  report.push('| Instruction | Latency | Throughput/cycle |');
  report.push('|-------------|---------|------------------|');
  for (const [insn, data] of Object.entries(FIRESTORM_LATENCIES)) {
    report.push(`| ${insn.padEnd(11)} | ${String(data.latency).padEnd(7)} | ${data.throughput}/cycle${' '.repeat(10 - String(data.throughput).length - 6)}|`);
  }
  report.push('');
  report.push('*Source: [Dougall Johnson](https://dougallj.github.io/applecpu/firestorm.html)*');
  report.push('');

  // ── Issues Summary ──
  if (issues.length > 0) {
    report.push('## Issues');
    report.push('');
    for (const issue of issues) {
      const icon = issue.severity === 'critical' ? '🔴' : issue.severity === 'high' ? '🟠' : '🟡';
      report.push(`${icon} **[${issue.area}]** ${issue.msg}`);
    }
    report.push('');
  }

  // ── Suggestions ──
  suggestions.push({
    area: 'Apple Silicon General',
    fixes: [
      'Use -mcpu=apple-m4 (or -mcpu=apple-m1) with clang for optimal scheduling',
      'Enable LTO (-flto) — Apple\'s linker is excellent at cross-module optimization',
      'Use Accelerate.framework for BLAS/LAPACK/FFT instead of hand-rolled code',
      'Profile with Instruments → CPU Counters template for detailed PMC data',
      'Use os_signpost for precise timing of code regions',
    ],
  });

  if (suggestions.length > 0) {
    report.push('## Recommendations');
    report.push('');
    for (const s of suggestions) {
      report.push(`### ${s.area}`);
      for (const fix of s.fixes) report.push(`- ${fix}`);
      report.push('');
    }
  }

  return report.join('\n');
}

// ── Main ────────────────────────────────────────────────────────────────────

const chip = detectChip(resultsDir);
const powerData = parsePowermetrics(path.join(resultsDir, 'powermetrics.txt'));
const topFunctions = parseTopFunctions(path.join(resultsDir, 'top-functions.txt'));
const timing = parseTimingResults(path.join(resultsDir, 'timing.txt'));

const report = analyze(chip, powerData, topFunctions, timing);
console.log(report);

// Export for use as module
module.exports = { CHIPS, FUSION_RULES, FIRESTORM_LATENCIES, analyze };
