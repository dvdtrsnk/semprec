# Batch 12 specification reconciliation

## 1. Item-link guard and future write consumers

Owner-delegated controller thr_pz39tcih5r confirmed on the batch-12 base that
`assertItemLinksExist` has no production write caller. The shared parser is pure;
the current journal caller is read-only. Original gh-1614 handover states this
limitation and is preserved, not accepted as a waiver.

Gh-1614 now explicitly delivers the pure item-link format/collection and the
backend guard contract with actual parsed-block, runtime-role two-tenant tests.
Unknown, foreign, deleted and malformed targets must give the same safe typed
400 validation contract, with a live local positive and no document/relation
writes. Add no REST/MCP endpoint or database I/O in the shared parser.

Actual page-write invocation and authenticated HTTP response assertions are
assigned explicitly to existing owners gh-1679 (batch38) and gh-1765 (batch47).
Their prerequisites, Tasks and AC now require the guard on the write client,
whole-write rollback on refusal and real positive/unknown/foreign/deleted/invalid
HTTP controls. Their future aggregates/manifests are refreshed but remain
proposed; this is not authorization to execute them now. Current batch-12
evidence must say HTTP integration NOT RUN, not infer it from helper exceptions.

The additive ADR is
[[2026-11-02-markdown-item-links-are-validated-by-tenant-write-owners]]. Accepted
historical ADR bodies, all original handovers and worker's unrelated dirty AI
usage implementation are unchanged. No missing implemented endpoint is
represented as passing. Batch-12 implementation/review/runtime gates remain.
