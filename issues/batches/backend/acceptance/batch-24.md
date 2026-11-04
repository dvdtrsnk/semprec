# Batch 24 local acceptance receipt

The ordered members are gh-1515, gh-1520, gh-1579, gh-1530, gh-1517, gh-1523, gh-1529, gh-1535, gh-1556 and gh-1554. Existing handovers for gh-1515, gh-1520, gh-1517 and gh-1529 remain byte-identical original provenance. Six new member handovers and the aggregate handover describe this local completion.

## Decision and evidence

The owner-delegated parent accepted candidate `7637bcb29a980f7516766a41778c0863c430688b`, tree `7301ad7405385e24cc3be82e2431add8bb7d2b4a`, for local integration only. The retained decision `batch-24-run/parent-local-acceptance-7637.json` has SHA-256 `795bfb276911b21341bcce89ed4de16c4430caaa559b21c08a00acfbd66a93fc`. The final packet `batch-24-run/final-packet-7637.json` has SHA-256 `d72fbf8169405077ba3e80f7c4e54edda58c254e7421350c211042b43e9aec07`; the immutable ledger `batch-24-run/clause-ledger-final-7637.json` has SHA-256 `623cfd226ad66984586a4362da545f627e7e5d1e6a875445d1810107cf57a2f6`. Historical ledger candidate fields and individual `implementationSha` and `testedHead` values identify their actual source and executions, not the current accepted candidate.

One complete R1 was NOT CLEAR on `9d07acc974ef8c91da5fd7292e85dd597556ea1f`; the same reviewer's focused R2 was CLEAR for the H1/M2/M3 repairs on `f5cae4450b59590f50aa78db2364a559481e0ff1`. The parent directly inspected the later finite changes. No third review was conducted.

The actual unchanged verify on `f5cae4450b59590f50aa78db2364a559481e0ff1` failed at write-safety; subsequent phases in that verify were not run. Full integration on `f6025e5df0bd726e1a871633774f93805e31dd0f` failed five of 6,692 tests. The later three-file compatibility control passed 46/46 on `2663a00909e0a2e9d409515fb298c47d707743e8`; standalone full E2E passed 47/47 on `7637bcb29a980f7516766a41778c0863c430688b`. Full verify and full integration on the accepted candidate were not run. Passing standalone stages do not turn the failed verify into a pass.

## Candidate-local exceptions

- **L1:** Full verify on 7637 was not run; the actual f5ca verify failed. Earlier successful phases remain attributed to f5ca. Bounded later checks support local acceptance only.
- **L2:** Full integration on 7637 was not run; the actual f602 integration failed five tests. Search and relation fixtures were repaired with whole-file controls; the macOS MCP inherited-name assertion still observed an extra `__CF_USER_TEXT_ENCODING`.
- **L3:** Two original f602 CLI fixture database DROPs timed out and their individual absence was not established. The separate 2663 controls passed their own creator-settled and database-absence assertions, but their reporter did not retain creator/remover identities.
- **L4:** E2E on 2663 was interrupted by one authorized SIGTERM and exited 143 after the observed IPv4/IPv6 endpoint collision. Final PostgreSQL shutdown-complete was not captured and that owned data directory remains retained. The later passing E2E is separate evidence and does not explain earlier SSH failures.
- **L5:** The ledger retains actual source and run attribution, indexed-vector rather than search-endpoint evidence, domain 409 rather than exact HTTP evidence, ignored-input and byte-carry limits, and process-sampling limits. Skills-use claims are procedural. The owned seed-copy shell proof covers clean, stale and repeat parity, not the complete build or shared dist. These exceptions do not transfer to future candidates.

The old 4f23 lint failure and all other historical outcomes remain preserved. No sampled process list proves absence of unseen or reparented children or individual historical DROP. `gh-1086` remains byte-identical **OPEN/BLOCKED** for release. No production approval, live provider/account activity, push or deployment is included.
