Check for architecture and ownership violations:

1. A write to persisted state that bypasses the generic choke-point API (see rules.md)
   — critical severity, unless this PR's linked issue is the one introducing the
   choke-point itself.
2. Two different processes/modules writing to the same table or field without a
   documented ownership handoff — high severity.
3. A schema change outside `0001_baseline.sql` (a second migration file or an
   appended `ALTER`), or upgrade code for older data (backfill, cutover, reconcile,
   compatibility branch) — medium (see rules.md).
4. New abstraction, config flag, or generalization not required by the linked issue's
   Task section — medium severity (flag it as scope creep, not a style nitpick).
5. A module reaching into another module's internals instead of its declared
   contract/exported interface — high severity.
6. An LLM/AI-provider call (SDK import, HTTP call to a model API) anywhere outside
   `semprec-ai-gateway` — critical: it bypasses `ai_gateway_calls` logging and the
   budget caps. Only the gateway itself may talk to providers.
7. AI/agent code writing persisted state directly instead of producing a proposal
   that goes through the approval queue / `confirm` flow — high severity, even if the
   write itself is correct.
8. Code that contradicts a rule in `docs/architecture/` without the document being
   updated in the same pull request — medium. Do not ask for a document or ADR for a
   local pattern.
