#!/usr/bin/env node
/**
 * fusion-check.js — ARM64 Macro-op Fusion Analyzer
 * 
 * Analyzes ARM64 binaries or objdump output to identify instruction pairs
 * that will fuse on Apple Silicon vs standard ARM cores.
 * 
 * Usage:
 *   node fusion-check.js <binary>                    # Disassemble and analyze
 *   node fusion-check.js --objdump <objdump-output>  # Analyze existing disassembly
 *   node fusion-check.js <binary> --function main    # Analyze specific function
 *   node fusion-check.js <binary> --verbose           # Show all pairs
 * 
 * Works on both macOS and Linux (cross-analysis).
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// ── Fusion Rules ────────────────────────────────────────────────────────────

const FUSION_CATEGORIES = {
  // Fuses on both Apple Silicon and Neoverse-N1/N2
  standard: {
    label: 'Standard ARM fusion',
    rules: [
      { first: /^CMP\s/i,  second: /^B\.(EQ|NE|LT|GT|LE|GE|CS|CC|HI|LS|MI|PL|VS|VC|AL)\s/i, name: 'CMP+B.cond' },
      { first: /^CMN\s/i,  second: /^B\.(EQ|NE|LT|GT|LE|GE|CS|CC|HI|LS|MI|PL|VS|VC|AL)\s/i, name: 'CMN+B.cond' },
      { first: /^TST\s/i,  second: /^B\.(EQ|NE|LT|GT|LE|GE|CS|CC|HI|LS|MI|PL|VS|VC|AL)\s/i, name: 'TST+B.cond' },
      { first: /^ADDS\s/i, second: /^B\.(EQ|NE|LT|GT|LE|GE|CS|CC|HI|LS|MI|PL|VS|VC|AL)\s/i, name: 'ADDS+B.cond' },
      { first: /^SUBS\s/i, second: /^B\.(EQ|NE|LT|GT|LE|GE|CS|CC|HI|LS|MI|PL|VS|VC|AL)\s/i, name: 'SUBS+B.cond' },
      { first: /^ANDS\s/i, second: /^B\.(EQ|NE|LT|GT|LE|GE|CS|CC|HI|LS|MI|PL|VS|VC|AL)\s/i, name: 'ANDS+B.cond' },
    ],
  },
  // Apple Silicon only — not fused on Neoverse
  appleOnly: {
    label: 'Apple Silicon-specific fusion',
    rules: [
      { first: /^ADD\s/i,  second: /^B\.(EQ|NE|LT|GT|LE|GE|CS|CC|HI|LS|MI|PL|VS|VC|AL)\s/i, name: 'ADD+B.cond' },
      { first: /^SUB\s/i,  second: /^B\.(EQ|NE|LT|GT|LE|GE|CS|CC|HI|LS|MI|PL|VS|VC|AL)\s/i, name: 'SUB+B.cond' },
      { first: /^ADRP\s/i, second: /^ADD\s/i,  name: 'ADRP+ADD (address generation)' },
      { first: /^ADRP\s/i, second: /^LDR\s/i,  name: 'ADRP+LDR (address generation)' },
      { first: /^AES[ED]\s/i, second: /^AESI?MC\s/i, name: 'AES+AESMC (crypto)' },
    ],
  },
};

// ── Missed Fusion Opportunities ─────────────────────────────────────────────
// Patterns where the compiler could have arranged instructions to enable fusion

const MISSED_PATTERNS = [
  {
    name: 'CMP separated from B.cond',
    desc: 'CMP and conditional branch have instructions between them — prevents fusion',
    detect: (insns, i) => {
      if (!/^CMP\s/i.test(insns[i].mnemonic)) return false;
      // Check if a B.cond exists within 3 instructions but not immediately after
      for (let j = i + 2; j < Math.min(i + 4, insns.length); j++) {
        if (/^B\.(EQ|NE|LT|GT|LE|GE|CS|CC|HI|LS|MI|PL)\s/i.test(insns[j].mnemonic)) {
          return true;
        }
      }
      return false;
    },
    fix: 'Move CMP immediately before the conditional branch to enable fusion',
  },
  {
    name: 'ADRP separated from ADD/LDR',
    desc: 'ADRP and ADD/LDR have instructions between them — prevents Apple fusion',
    detect: (insns, i) => {
      if (!/^ADRP\s/i.test(insns[i].mnemonic)) return false;
      for (let j = i + 2; j < Math.min(i + 4, insns.length); j++) {
        if (/^(ADD|LDR)\s/i.test(insns[j].mnemonic)) {
          // Check if they reference the same register
          const adrpReg = insns[i].operands.split(',')[0]?.trim();
          const nextOp = insns[j].operands;
          if (adrpReg && nextOp.includes(adrpReg)) return true;
        }
      }
      return false;
    },
    fix: 'Place ADD/LDR immediately after ADRP for Apple Silicon address generation fusion',
  },
  {
    name: 'AES without AESMC',
    desc: 'AES encrypt/decrypt without immediate AESMC — missed crypto fusion',
    detect: (insns, i) => {
      if (!/^AES[ED]\s/i.test(insns[i].mnemonic)) return false;
      if (i + 1 < insns.length && /^AESI?MC\s/i.test(insns[i + 1].mnemonic)) return false;
      return true;
    },
    fix: 'Place AESMC/AESIMC immediately after AESE/AESD for crypto fusion',
  },
];

// ── Parse Disassembly ───────────────────────────────────────────────────────

function parseDisassembly(text) {
  const functions = [];
  let currentFunc = null;

  for (const line of text.split('\n')) {
    // Function header: "0000000100003f40 <_main>:" or similar
    const funcMatch = line.match(/^[\da-f]+\s+<([^>]+)>:/i) ||
                      line.match(/^([^\s:]+):/);
    if (funcMatch && !line.match(/^\s/)) {
      if (currentFunc) functions.push(currentFunc);
      currentFunc = { name: funcMatch[1], instructions: [] };
      continue;
    }

    // Instruction line: "  100003f44:  d10083ff  sub  sp, sp, #0x20"
    // or: "  100003f44:  sub  sp, sp, #0x20"
    const insnMatch = line.match(/^\s*([\da-f]+):\s+(?:[\da-f]+\s+)?(\w+)\s*(.*)/i);
    if (insnMatch && currentFunc) {
      currentFunc.instructions.push({
        addr: insnMatch[1],
        mnemonic: insnMatch[2].toUpperCase(),
        operands: insnMatch[3].trim(),
        raw: line.trim(),
      });
    }
  }
  if (currentFunc) functions.push(currentFunc);
  return functions;
}

// ── Analyze Fusion ──────────────────────────────────────────────────────────

function analyzeFusion(functions, targetFunction) {
  const results = {
    totalInstructions: 0,
    standardFusions: [],
    appleFusions: [],
    missedOpportunities: [],
    summary: { standard: 0, appleOnly: 0, missed: 0 },
    perFunction: [],
  };

  const funcsToAnalyze = targetFunction
    ? functions.filter(f => f.name.includes(targetFunction))
    : functions;

  for (const func of funcsToAnalyze) {
    const insns = func.instructions;
    const funcResult = { name: func.name, standard: 0, appleOnly: 0, missed: 0 };
    results.totalInstructions += insns.length;

    for (let i = 0; i < insns.length - 1; i++) {
      const curr = insns[i];
      const next = insns[i + 1];

      // Check standard fusion
      for (const rule of FUSION_CATEGORIES.standard.rules) {
        if (rule.first.test(curr.mnemonic + ' ') && rule.second.test(next.mnemonic + ' ')) {
          results.standardFusions.push({
            function: func.name,
            addr: curr.addr,
            pair: `${curr.raw}  →  ${next.raw}`,
            rule: rule.name,
          });
          results.summary.standard++;
          funcResult.standard++;
        }
      }

      // Check Apple-specific fusion
      for (const rule of FUSION_CATEGORIES.appleOnly.rules) {
        if (rule.first.test(curr.mnemonic + ' ') && rule.second.test(next.mnemonic + ' ')) {
          results.appleFusions.push({
            function: func.name,
            addr: curr.addr,
            pair: `${curr.raw}  →  ${next.raw}`,
            rule: rule.name,
          });
          results.summary.appleOnly++;
          funcResult.appleOnly++;
        }
      }

      // Check missed opportunities
      for (const pattern of MISSED_PATTERNS) {
        if (pattern.detect(insns, i)) {
          results.missedOpportunities.push({
            function: func.name,
            addr: curr.addr,
            instruction: curr.raw,
            pattern: pattern.name,
            fix: pattern.fix,
          });
          results.summary.missed++;
          funcResult.missed++;
        }
      }
    }

    if (funcResult.standard + funcResult.appleOnly + funcResult.missed > 0) {
      results.perFunction.push(funcResult);
    }
  }

  return results;
}

// ── Format Report ───────────────────────────────────────────────────────────

function formatReport(results, verbose) {
  const lines = [];

  lines.push('# ARM64 Macro-op Fusion Analysis');
  lines.push('');
  lines.push(`Total instructions analyzed: ${results.totalInstructions.toLocaleString()}`);
  lines.push('');

  // Summary
  lines.push('## Summary');
  lines.push('');
  lines.push(`| Category | Count | Effect |`);
  lines.push(`|----------|-------|--------|`);
  lines.push(`| Standard fusion (N1 + Apple) | ${results.summary.standard} | Fuses on all modern ARM |`);
  lines.push(`| Apple-specific fusion | ${results.summary.appleOnly} | Fuses ONLY on Apple Silicon |`);
  lines.push(`| Missed opportunities | ${results.summary.missed} | Could fuse but instructions not adjacent |`);
  lines.push('');

  const totalFusable = results.summary.standard + results.summary.appleOnly;
  if (totalFusable > 0 && results.totalInstructions > 0) {
    // Each fusion saves 1 decode slot (2 insns → 1 macro-op)
    const savedSlots = totalFusable;
    const throughputImprovement = (savedSlots / results.totalInstructions * 100).toFixed(2);
    lines.push(`**Theoretical throughput improvement from fusion:** ${throughputImprovement}%`);
    lines.push(`(${savedSlots} decode slots saved across ${results.totalInstructions} instructions)`);

    if (results.summary.appleOnly > 0) {
      const appleExtra = (results.summary.appleOnly / results.totalInstructions * 100).toFixed(2);
      lines.push(`**Apple Silicon advantage:** +${appleExtra}% additional fusion vs standard ARM`);
    }
    lines.push('');
  }

  // Per-function breakdown
  if (results.perFunction.length > 0) {
    lines.push('## Per-Function Breakdown');
    lines.push('');
    const sorted = results.perFunction.sort((a, b) =>
      (b.standard + b.appleOnly + b.missed) - (a.standard + a.appleOnly + a.missed));
    for (const f of sorted.slice(0, 20)) {
      lines.push(`- **${f.name}**: ${f.standard} standard, ${f.appleOnly} Apple-specific, ${f.missed} missed`);
    }
    lines.push('');
  }

  // Standard fusions
  if (results.standardFusions.length > 0) {
    lines.push('## Standard Fusion Pairs (N1 + Apple Silicon)');
    lines.push('');
    const byRule = {};
    for (const f of results.standardFusions) {
      byRule[f.rule] = (byRule[f.rule] || 0) + 1;
    }
    for (const [rule, count] of Object.entries(byRule).sort((a, b) => b[1] - a[1])) {
      lines.push(`- ${rule}: ${count}×`);
    }
    if (verbose) {
      lines.push('');
      for (const f of results.standardFusions.slice(0, 50)) {
        lines.push(`  [${f.function}@${f.addr}] ${f.rule}: ${f.pair}`);
      }
    }
    lines.push('');
  }

  // Apple-specific fusions
  if (results.appleFusions.length > 0) {
    lines.push('## Apple Silicon-Specific Fusion (not on N1/N2)');
    lines.push('');
    const byRule = {};
    for (const f of results.appleFusions) {
      byRule[f.rule] = (byRule[f.rule] || 0) + 1;
    }
    for (const [rule, count] of Object.entries(byRule).sort((a, b) => b[1] - a[1])) {
      lines.push(`- ${rule}: ${count}×`);
    }
    if (verbose) {
      lines.push('');
      for (const f of results.appleFusions.slice(0, 50)) {
        lines.push(`  [${f.function}@${f.addr}] ${f.rule}: ${f.pair}`);
      }
    }
    lines.push('');
  }

  // Missed opportunities
  if (results.missedOpportunities.length > 0) {
    lines.push('## Missed Fusion Opportunities');
    lines.push('');
    lines.push('These instruction sequences could fuse if rearranged:');
    lines.push('');
    const byPattern = {};
    for (const m of results.missedOpportunities) {
      byPattern[m.pattern] = byPattern[m.pattern] || { count: 0, fix: m.fix, examples: [] };
      byPattern[m.pattern].count++;
      if (byPattern[m.pattern].examples.length < 3) {
        byPattern[m.pattern].examples.push(`${m.function}@${m.addr}: ${m.instruction}`);
      }
    }
    for (const [pattern, data] of Object.entries(byPattern).sort((a, b) => b[1].count - a[1].count)) {
      lines.push(`### ${pattern} (${data.count}×)`);
      lines.push(`**Fix:** ${data.fix}`);
      for (const ex of data.examples) {
        lines.push(`  - ${ex}`);
      }
      lines.push('');
    }
  }

  // Cross-platform comparison
  lines.push('## Cross-Platform Comparison');
  lines.push('');
  lines.push('| Metric | Neoverse-N1 | Apple M-series |');
  lines.push('|--------|-------------|----------------|');
  lines.push(`| Standard fusions | ${results.summary.standard} | ${results.summary.standard} |`);
  lines.push(`| Apple-specific fusions | 0 | ${results.summary.appleOnly} |`);
  lines.push(`| Total fusions | ${results.summary.standard} | ${results.summary.standard + results.summary.appleOnly} |`);
  lines.push(`| Max fusions/cycle | 1 | 3 |`);
  lines.push(`| Effective saved decode slots | ${results.summary.standard} | ${results.summary.standard + results.summary.appleOnly} |`);
  lines.push('');

  return lines.join('\n');
}

// ── CLI ─────────────────────────────────────────────────────────────────────

function main() {
  const args = process.argv.slice(2);
  let input = null;
  let isObjdump = false;
  let targetFunction = null;
  let verbose = false;

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--objdump': isObjdump = true; input = args[++i]; break;
      case '--function': case '-f': targetFunction = args[++i]; break;
      case '--verbose': case '-v': verbose = true; break;
      case '--help': case '-h':
        console.log('Usage: node fusion-check.js <binary> [--function name] [--verbose]');
        console.log('       node fusion-check.js --objdump <disassembly.txt> [--function name]');
        process.exit(0);
      default:
        if (!input) input = args[i];
    }
  }

  if (!input) {
    console.error('Usage: node fusion-check.js <binary|--objdump file>');
    console.error('       node fusion-check.js --help');
    process.exit(1);
  }

  let disasmText;

  if (isObjdump) {
    disasmText = fs.readFileSync(input, 'utf8');
  } else {
    // Try to disassemble the binary
    const objdumpCmds = ['llvm-objdump', 'objdump', '/usr/bin/objdump'];
    let cmd = null;
    for (const c of objdumpCmds) {
      try {
        execSync(`which ${c}`, { stdio: 'pipe' });
        cmd = c;
        break;
      } catch {}
    }

    if (!cmd) {
      // macOS: try otool as last resort
      try {
        execSync('which otool', { stdio: 'pipe' });
        cmd = 'otool';
      } catch {
        console.error('Error: No disassembler found. Install llvm-objdump or binutils.');
        process.exit(1);
      }
    }

    try {
      if (cmd === 'otool') {
        disasmText = execSync(`otool -tvV "${input}"`, { maxBuffer: 100 * 1024 * 1024 }).toString();
      } else {
        const funcFlag = targetFunction ? `--disassemble-symbols=${targetFunction}` : '-d';
        disasmText = execSync(`${cmd} ${funcFlag} "${input}"`, { maxBuffer: 100 * 1024 * 1024 }).toString();
      }
    } catch (e) {
      console.error(`Error disassembling: ${e.message}`);
      process.exit(1);
    }
  }

  const functions = parseDisassembly(disasmText);

  if (functions.length === 0) {
    console.error('No functions found in disassembly output.');
    process.exit(1);
  }

  const results = analyzeFusion(functions, targetFunction);
  console.log(formatReport(results, verbose));
}

main();
