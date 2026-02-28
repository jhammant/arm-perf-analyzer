# ARM Performance Analysis Report

**CPU:** Neoverse-N1 (4-wide decode, 8-wide issue)
**Cycles:** 447,572,622,928
**Instructions:** 930,563,436,249
**IPC:** 2.08 (theoretical max: 4.0)

## IPC Efficiency
Achieved 52.0% of theoretical maximum IPC.

## Pipeline Stalls
- Frontend (fetch/decode): 3.8% idle
- Backend (execute/retire): 21.9% idle

## Cache Hierarchy
- L1I miss rate: 0.33% (934,873,436 / 285,899,901,515)
- L1D miss rate: 0.61% (1,231,993,757 / 202,992,509,007)
- LLC miss rate: 0.61% (1,226,660,272 / 202,169,237,343)

## Branch Prediction
- Branch miss rate: 0.00% (0 / 0)
- Each mispredict costs ~13 cycles
- Estimated cycle waste: 0 cycles (0.0% of total)

## TLB
- iTLB miss rate: 0.000%
- dTLB miss rate: 0.190%

## Neoverse-N1 Optimization Opportunities

**Macro-op fusion:** N1 fuses compare+branch pairs into single ops.
Ensure hot loops use: CMP/CMN/TST/ADDS/SUBS immediately followed by B.cond

**Decode width:** N1 decodes 4 instructions/cycle.
Keep critical loop bodies to multiples of 4 instructions for optimal decode throughput.

**ROB depth:** 128 entries. Long dependency chains starve the backend.
Break dependency chains by using independent accumulators (e.g., sum0 + sum1 instead of single sum).

## Issues Summary

🟡 **[IPC]** IPC 2.08 — room for improvement

