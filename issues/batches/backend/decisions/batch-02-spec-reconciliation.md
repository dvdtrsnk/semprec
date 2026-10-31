# Parent adjudication — batch 02

Authority: explicit owner delegation to parent thr_pz39tcih5r for autonomous project decisions.

- gh-1414: recognize the existing standalone accepted converter-context ADR and prior decision a8bcf732. Do not rewrite the accepted two-pass ADR.
- gh-1427: retain the intentionally empty module. Verify registry activation and absence of contributed databases/tools/routes; do not invent module-list/route-list fields outside this issue's Task.
- gh-1459: the requested two-column items FK is not expressible without the partition key. Retain the users tenant FK and applied migration; require a same-transaction, row-locked, tenant-scoped Projects attribution guard with negative/no-write tests and a scoped ADR. This is an explicit integrity mechanism change, not acceptance of the old handover's omission as compliance.

The source requirements and aggregate were revised, reapproved under delegated authority and included in the canonical manifest. Execution must refreeze against this commit before resuming. No production code changed in this decision.

- gh-1414: 783d5d197b3fbccec89902272a114b7125bbf0c397e5d1b29f72b7664dc65d22 -> 34e7b7ce3760ad9284f5f9b0c6f67255b5bc1e01eeec62524ffab5f3045b0dd7
- gh-1427: 9b6720159991c5997a99ce65b5b706359c0417b04b3240bad7d93bf4d101e90e -> b0cd0f1d573b358eb40b0e0608474f5e04f98eb751a4b5eee0e902e3b566addb
- gh-1459: 08799f92d266790b7e5ab00b0874b7f2aac066857b234d19afb6469537942e3c -> 71a2254f0df58f303b82fc487adac3b0862a1d00e3b5499930693d37e42ea5d6
