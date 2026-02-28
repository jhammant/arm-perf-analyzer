# ARM Performance Analysis Report

**CPU:** Neoverse-N1 (4-wide decode, 8-wide issue)
**Cycles:** 174,877,338,129
**Instructions:** 488,610,021,645
**IPC:** 2.79 (theoretical max: 4.0)

## IPC Efficiency
Achieved 69.8% of theoretical maximum IPC.

## Pipeline Stalls
- Frontend (fetch/decode): 0.1% idle
- Backend (execute/retire): 19.2% idle

## Cache Hierarchy
- L1I miss rate: 0.00% (17,210,844 / 0)
- L1D miss rate: 0.01% (4,063,764 / 70,614,676,943)
- LLC miss rate: 0.01% (4,201,774 / 70,550,783,812)

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

🟡 **[IPC]** IPC 2.79 — room for improvement

