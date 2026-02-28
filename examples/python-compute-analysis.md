# ARM Performance Analysis Report

**CPU:** Neoverse-N1 (4-wide decode, 8-wide issue)
**Cycles:** 22,975,596,293
**Instructions:** 66,897,429,790
**IPC:** 2.91 (theoretical max: 4.0)

## IPC Efficiency
Achieved 72.8% of theoretical maximum IPC.

## Pipeline Stalls
- Frontend (fetch/decode): 2.7% idle
- Backend (execute/retire): 11.4% idle

## Cache Hierarchy
- L1I miss rate: 0.00% (8,522,356 / 0)
- L1D miss rate: 0.14% (29,113,382 / 20,766,335,062)
- LLC miss rate: 0.14% (28,714,944 / 20,763,204,407)

## Branch Prediction
- Branch miss rate: 0.00% (0 / 0)
- Each mispredict costs ~13 cycles
- Estimated cycle waste: 0 cycles (0.0% of total)

## TLB
- iTLB miss rate: 0.000%
- dTLB miss rate: 0.000%

## Neoverse-N1 Optimization Opportunities

**Macro-op fusion:** N1 fuses compare+branch pairs into single ops.
Ensure hot loops use: CMP/CMN/TST/ADDS/SUBS immediately followed by B.cond

**Decode width:** N1 decodes 4 instructions/cycle.
Keep critical loop bodies to multiples of 4 instructions for optimal decode throughput.

**ROB depth:** 128 entries. Long dependency chains starve the backend.
Break dependency chains by using independent accumulators (e.g., sum0 + sum1 instead of single sum).

## Issues Summary

🟡 **[IPC]** IPC 2.91 — room for improvement

