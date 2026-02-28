#!/usr/bin/env node
/**
 * ARM Performance Analyzer — Parse perf output and generate optimization report.
 * 
 * Reads perf stat output, identifies bottlenecks, suggests fixes.
 * Designed for Neoverse-N1 but works on any ARMv8.
 */

const fs = require('fs');
const path = require('path');

const resultsDir = process.argv[2];
if (!resultsDir) {
  console.error('Usage: node analyzer.js <results-dir>');
  process.exit(1);
}

// ── Parse perf stat output ──────────────────────────────────────────────────

function parsePerfStat(file) {
  const text = fs.readFileSync(file, 'utf8');
  const counters = {};
  
  for (const line of text.split('\n')) {
    // Match lines like: "  1,234,567      cycles"
    const match = line.match(/^\s*([\d,]+)\s+(\S+)/);
    if (match) {
      const value = parseInt(match[1].replace(/,/g, ''), 10);
      const name = match[2];
      if (!isNaN(value)) counters[name] = value;
    }
    // Match "# X.XX insn per cycle"
    const ipcMatch = line.match(/#\s+([\d.]+)\s+insn per cycle/);
    if (ipcMatch) counters['_ipc'] = parseFloat(ipcMatch[1]);
    
    // Match stall percentages
    const stallMatch = line.match(/#\s+([\d.]+)%\s+(frontend|backend) cycles idle/);
    if (stallMatch) counters[`_${stallMatch[2]}_stall_pct`] = parseFloat(stallMatch[1]);
  }
  
  return counters;
}

// ── Neoverse-N1 characteristics ─────────────────────────────────────────────

const N1 = {
  name: 'Neoverse-N1',
  decodeWidth: 4,        // 4-wide decode
  issueWidth: 8,         // 8 micro-ops/cycle dispatch
  retireWidth: 8,        // 8 micro-ops/cycle retire
  robSize: 128,          // Reorder buffer entries
  l1iSize: 64 * 1024,    // 64KB L1I
  l1dSize: 64 * 1024,    // 64KB L1D
  l2Size: 1024 * 1024,   // 1MB L2
  l1iLatency: 1,         // cycles
  l1dLatency: 4,         // cycles
  l2Latency: 10,         // cycles
  l3Latency: 40,         // cycles (system-dependent)
  branchMisPenalty: 13,   // cycles
  // Known fusion pairs (Neoverse-N1)
  fusionPairs: [
    'CMP+B.cond',        // Compare + conditional branch
    'CMN+B.cond',
    'TST+B.cond',
    'AND+B.cond',
    'ADDS+B.cond',
    'SUBS+B.cond',
  ],
  maxFusionPerCycle: 1,   // N1 can fuse 1 pair per cycle
};

// ── Analysis ────────────────────────────────────────────────────────────────

function analyze(counters, armCounters) {
  const report = [];
  const issues = [];
  const suggestions = [];
  
  const cycles = counters.cycles || 0;
  const instructions = counters.instructions || 0;
  const ipc = counters._ipc || (cycles > 0 ? instructions / cycles : 0);
  const frontendStall = counters._frontend_stall_pct || 0;
  const backendStall = counters._backend_stall_pct || 0;
  
  // Cache stats
  const cacheRefs = counters['cache-references'] || 0;
  const cacheMisses = counters['cache-misses'] || 0;
  const cacheMissRate = cacheRefs > 0 ? (cacheMisses / cacheRefs * 100) : 0;
  
  const l1iLoads = counters['L1-icache-loads'] || 0;
  const l1iMisses = counters['L1-icache-load-misses'] || 0;
  const l1iMissRate = l1iLoads > 0 ? (l1iMisses / l1iLoads * 100) : 0;
  
  const l1dLoads = counters['L1-dcache-loads'] || 0;
  const l1dMisses = counters['L1-dcache-load-misses'] || 0;
  const l1dMissRate = l1dLoads > 0 ? (l1dMisses / l1dLoads * 100) : 0;
  
  // Branch stats
  const branchLoads = counters['branch-loads'] || armCounters?.br_pred || 0;
  const branchMisses = counters['branch-misses'] || armCounters?.br_mis_pred || 0;
  const branchMissRate = branchLoads > 0 ? (branchMisses / branchLoads * 100) : 0;
  
  // TLB stats
  const iTlbLoads = counters['iTLB-loads'] || 0;
  const iTlbMisses = counters['iTLB-load-misses'] || 0;
  const dTlbLoads = counters['dTLB-loads'] || 0;
  const dTlbMisses = counters['dTLB-load-misses'] || 0;
  
  // ── Header ──
  report.push('# ARM Performance Analysis Report');
  report.push('');
  report.push(`**CPU:** ${N1.name} (${N1.decodeWidth}-wide decode, ${N1.issueWidth}-wide issue)`);
  report.push(`**Cycles:** ${cycles.toLocaleString()}`);
  report.push(`**Instructions:** ${instructions.toLocaleString()}`);
  report.push(`**IPC:** ${ipc.toFixed(2)} (theoretical max: ${N1.decodeWidth}.0)`);
  report.push('');
  
  // ── IPC Analysis ──
  report.push('## IPC Efficiency');
  const ipcEfficiency = (ipc / N1.decodeWidth * 100).toFixed(1);
  report.push(`Achieved ${ipcEfficiency}% of theoretical maximum IPC.`);
  
  if (ipc < 1.0) {
    issues.push({ severity: 'critical', area: 'IPC', msg: `IPC ${ipc.toFixed(2)} is very low — significant bottleneck present` });
  } else if (ipc < 2.0) {
    issues.push({ severity: 'high', area: 'IPC', msg: `IPC ${ipc.toFixed(2)} is below 50% efficiency` });
  } else if (ipc < 3.0) {
    issues.push({ severity: 'medium', area: 'IPC', msg: `IPC ${ipc.toFixed(2)} — room for improvement` });
  }
  report.push('');
  
  // ── Pipeline Stalls ──
  report.push('## Pipeline Stalls');
  report.push(`- Frontend (fetch/decode): ${frontendStall.toFixed(1)}% idle`);
  report.push(`- Backend (execute/retire): ${backendStall.toFixed(1)}% idle`);
  
  if (frontendStall > 30) {
    issues.push({ severity: 'critical', area: 'Frontend', msg: `${frontendStall.toFixed(1)}% frontend stalls — instruction supply bottleneck` });
    suggestions.push({
      area: 'Frontend',
      fixes: [
        'Check L1I cache misses — code may be too large for cache',
        'Consider loop fission: split large loops into smaller ones that fit in L1I',
        'Align hot loop entries to 64-byte boundaries: __attribute__((aligned(64)))',
        'Reduce function call depth in hot paths (inline critical functions)',
        'Check for iTLB misses — large code footprint may thrash iTLB',
      ],
    });
  } else if (frontendStall > 15) {
    issues.push({ severity: 'medium', area: 'Frontend', msg: `${frontendStall.toFixed(1)}% frontend stalls — moderate instruction supply issues` });
  }
  
  if (backendStall > 40) {
    issues.push({ severity: 'critical', area: 'Backend', msg: `${backendStall.toFixed(1)}% backend stalls — execution/memory bottleneck` });
    suggestions.push({
      area: 'Backend',
      fixes: [
        'Check data cache miss rates — likely waiting on memory',
        'Add __builtin_prefetch() for predictable access patterns',
        'Consider data structure layout — AoS→SoA transformation',
        'Reduce data dependencies in inner loops (loop unrolling, software pipelining)',
        'Check for false sharing in multithreaded code (align to 64-byte cache lines)',
      ],
    });
  } else if (backendStall > 25) {
    issues.push({ severity: 'medium', area: 'Backend', msg: `${backendStall.toFixed(1)}% backend stalls — some execution bottleneck` });
  }
  report.push('');
  
  // ── Cache Analysis ──
  report.push('## Cache Hierarchy');
  report.push(`- L1I miss rate: ${l1iMissRate.toFixed(2)}% (${l1iMisses.toLocaleString()} / ${l1iLoads.toLocaleString()})`);
  report.push(`- L1D miss rate: ${l1dMissRate.toFixed(2)}% (${l1dMisses.toLocaleString()} / ${l1dLoads.toLocaleString()})`);
  report.push(`- LLC miss rate: ${cacheMissRate.toFixed(2)}% (${cacheMisses.toLocaleString()} / ${cacheRefs.toLocaleString()})`);
  
  if (l1iMissRate > 5) {
    issues.push({ severity: 'high', area: 'L1I Cache', msg: `${l1iMissRate.toFixed(1)}% I-cache miss rate — code doesn't fit in L1I (${N1.l1iSize/1024}KB)` });
    suggestions.push({
      area: 'I-Cache',
      fixes: [
        'Use __attribute__((cold)) on error paths and rarely-executed code',
        'Move cold code to separate sections: -ffunction-sections + linker script',
        'Loop fission: split large loops so hot path fits in L1I',
        `N1 L1I is ${N1.l1iSize/1024}KB — keep hot loop body under ~${(N1.l1iSize*0.75/1024).toFixed(0)}KB`,
      ],
    });
  }
  
  if (l1dMissRate > 10) {
    issues.push({ severity: 'high', area: 'L1D Cache', msg: `${l1dMissRate.toFixed(1)}% D-cache miss rate — data access pattern not cache-friendly` });
    suggestions.push({
      area: 'D-Cache',
      fixes: [
        'Check data access patterns — stride-1 access is best',
        'AoS → SoA transformation for hot fields',
        '__builtin_prefetch() with distance = L2 latency × throughput',
        'Cache line padding to prevent false sharing (alignas(64))',
        `N1 L1D is ${N1.l1dSize/1024}KB with ${N1.l1dLatency}-cycle latency`,
      ],
    });
  }
  report.push('');
  
  // ── Branch Analysis ──
  report.push('## Branch Prediction');
  report.push(`- Branch miss rate: ${branchMissRate.toFixed(2)}% (${branchMisses.toLocaleString()} / ${branchLoads.toLocaleString()})`);
  report.push(`- Each mispredict costs ~${N1.branchMisPenalty} cycles`);
  
  const branchCycleWaste = branchMisses * N1.branchMisPenalty;
  const branchWastePct = cycles > 0 ? (branchCycleWaste / cycles * 100) : 0;
  report.push(`- Estimated cycle waste: ${branchCycleWaste.toLocaleString()} cycles (${branchWastePct.toFixed(1)}% of total)`);
  
  if (branchMissRate > 5) {
    issues.push({ severity: 'high', area: 'Branches', msg: `${branchMissRate.toFixed(1)}% branch miss rate — ${branchWastePct.toFixed(1)}% cycles wasted` });
    suggestions.push({
      area: 'Branches',
      fixes: [
        'Replace branches with conditional moves (CSEL on ARM)',
        'Use __builtin_expect() to hint likely/unlikely paths',
        'Branchless min/max: use bitwise operations',
        'Sort data to improve branch prediction for data-dependent branches',
        'Consider lookup tables instead of switch statements',
      ],
    });
  }
  report.push('');
  
  // ── TLB Analysis ──
  if (iTlbMisses > 0 || dTlbMisses > 0) {
    report.push('## TLB');
    const iTlbRate = iTlbLoads > 0 ? (iTlbMisses / iTlbLoads * 100) : 0;
    const dTlbRate = dTlbLoads > 0 ? (dTlbMisses / dTlbLoads * 100) : 0;
    report.push(`- iTLB miss rate: ${iTlbRate.toFixed(3)}%`);
    report.push(`- dTLB miss rate: ${dTlbRate.toFixed(3)}%`);
    
    if (dTlbRate > 1) {
      issues.push({ severity: 'medium', area: 'TLB', msg: `${dTlbRate.toFixed(2)}% dTLB miss rate — consider hugepages` });
      suggestions.push({
        area: 'TLB',
        fixes: [
          'Use 2MB hugepages: madvise(addr, len, MADV_HUGEPAGE)',
          'Reduce working set or improve data locality',
          'Pool allocations to reduce page count',
        ],
      });
    }
    report.push('');
  }
  
  // ── Neoverse-N1 Specific ──
  report.push('## Neoverse-N1 Optimization Opportunities');
  report.push('');
  report.push('**Macro-op fusion:** N1 fuses compare+branch pairs into single ops.');
  report.push('Ensure hot loops use: CMP/CMN/TST/ADDS/SUBS immediately followed by B.cond');
  report.push('');
  report.push('**Decode width:** N1 decodes 4 instructions/cycle.');
  report.push('Keep critical loop bodies to multiples of 4 instructions for optimal decode throughput.');
  report.push('');
  report.push(`**ROB depth:** ${N1.robSize} entries. Long dependency chains starve the backend.`);
  report.push('Break dependency chains by using independent accumulators (e.g., sum0 + sum1 instead of single sum).');
  report.push('');
  
  // ── Summary ──
  report.push('## Issues Summary');
  report.push('');
  
  const bySeverity = { critical: [], high: [], medium: [] };
  for (const issue of issues) {
    bySeverity[issue.severity].push(issue);
  }
  
  for (const sev of ['critical', 'high', 'medium']) {
    const icon = sev === 'critical' ? '🔴' : sev === 'high' ? '🟠' : '🟡';
    for (const issue of bySeverity[sev]) {
      report.push(`${icon} **[${issue.area}]** ${issue.msg}`);
    }
  }
  report.push('');
  
  // ── Suggestions ──
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
  
  return report.join('\n');
}

// ── Main ────────────────────────────────────────────────────────────────────

const counters = parsePerfStat(path.join(resultsDir, 'perf-stat.txt'));
let armCounters = {};
try {
  armCounters = parsePerfStat(path.join(resultsDir, 'arm-pmu.txt'));
} catch {}

const report = analyze(counters, armCounters);
console.log(report);
