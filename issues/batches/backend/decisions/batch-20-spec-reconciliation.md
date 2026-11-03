# Batch20 specification reconciliation

Authority: owner-delegated parent controller thr_pz39tcih5r, autonomous local development instruction2026-11-03.

## gh-1262: preserve deliberate app_sole_tenant tests

Parent captured the exact non-SQL grep at clean base7223fef2. Production matches are only the getSoleTenantId helper, bootstrap harness and strictDefault invariant checker. Four existing test files (backend/packages/data/src/__tests__/{mcpConnectionFactory,tenancyCatalog,tenancyInvariants,tenantEntity}.test.ts) deliberately inspect the function, verify its absence from a default, inject a rejected legacy default or inspect a controlled MCP child context. Their presence is not a production user/session fallback.

Clarify Task4 and AC1 with this exact existing test whitelist; preserve all other clauses and Touches. Do not delete or rewrite these tests to silence grep, add new fixture fallbacks, weaken tenant isolation, or broaden allowed production references. Record all matches at final candidate and inspect their meaning; a new production match still fails. This is a requirement contradiction resolved by explicit evidence, not a generic test exemption or new architectural pattern.

The parent regenerated and approved exact source and aggregate specs and manifest hashes. No production/test/config source bytes changed. Other current approvals and all original handovers remain intact. This decision grants no gate PASS, production access or additional review round.
