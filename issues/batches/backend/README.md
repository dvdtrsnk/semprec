# Sequential backend delivery batches

The implementation unit is a technical batch, not an original feature epic or
an individual source issue. All work stays in one working tree with one source
writer at a time. This program is owner-requested planning; it does not start
implementation or alter the running Relay workflow.

## Inventory and authority

- 665 original implementation requirements and 4 batch-19 security-review corrective requirements are assigned exactly once (669 total). The four additions preserve, rather than replace or waive, the original requirements.
- 74 main-lane batch specifications cover 667 requirements. The two held client requirements remain separate.
- 2 held batches preserve the deferred client-only sources gh-1088 and gh-1611.
- The original 58 feature epics remain reporting groups. Sources keep their
  original parents, Task, AC, declared blockers and specification hashes.
- Every batch is a self-contained ordinary implementation record. New records
  are proposed and unqueued; sources are labeled execution:batch-source and
  agent:blocked with their individual ready intent removed.
- New aggregate specifications require owner approval (batch 01 is now explicitly authorized). They do not inherit
  source approvals. Sources without approval at planning time are:
  gh-1414, gh-1478, gh-1422, gh-1393, gh-1086, gh-1601, gh-1739, gh-1783, gh-1088, gh-1611. Resolve their approval before implementation;
  the ordinary source-completion guard remains in force.

The canonical manifest is [manifest.json](manifest.json); its program epic is
[sp-62331d42-78af-4b93-ae97-d5ccbe3324df](../../items/sp-62331d42-78af-4b93-ae97-d5ccbe3324df.md).
The accepted scoped exception is
[sequential-backend-delivery-batches](../../../docs/adr/2026-10-31-sequential-backend-delivery-batches.md).

## Branch isolation and first-batch authorization

Use local integration branch `feature/backend-delivery` and one temporary branch
per batch (`batch/backend-01` for the pilot), all in this same working tree.
The integration branch receives only independently accepted batches through
`git merge --no-ff`. Keep failed or unfinished work on its batch branch.
Do not change develop or push/deploy as part of this program.

The owner has authorized autonomous processing of the entire backend main lane.
Parent thread thr_pz39tcih5r makes project decisions, including batch19, supervises
review and acceptance, archives each finished worker and only then starts the
next. Exact proposed specs are approved at dispatch under this delegation.
See [CONTROLLER.md](CONTROLLER.md) for the complete continuation protocol.

Verified local implementation history was recovered from
`9b4929ba4e672a8f2b0c83a955bdf0679757fcc3`.
[reconciled-completions.json](reconciled-completions.json) records 205 previously
completed implementations, including every member of batch 01. Their code and
handover history are present; do not reimplement them. Source planning records
retain the owner-directed backend-only specifications and await batch acceptance.
Compare original specifications at the recovered commit when evaluating changed
requirements. Completion provenance is not proof of the newly packaged AC.

## Baseline and grouping

The original planning commit is `ccdf6042ac29bf94fcdf3d81bfb96b8defc80dea`, plus the owner-directed backend-only
scope edits in this working tree. Previous sessions may have newer local
integration work absent here. Reconcile those commits and handovers before
implementation. This inventory is not evidence that every listed requirement
still needs code. Update the manifest and affected proposed batch specs together
if reconciliation changes the remaining work; do not silently skip an AC.

The plan retains every declared source dependency, including shared-file
ordering. No capability dependency was guessed away. Within a batch, members are
listed in topological order; every other open dependency is assigned to an earlier
main batch. Adjacent main batches form an explicit sequential acceptance chain.
Completed external prerequisites are checked against actual local handovers.

Batch grouping favors common code areas among eligible members and is bounded
by the existing 60,000-character model-metadata limit. Every source Context,
Task, Touches, Scope and AC is embedded with demoted headings. Only the physical
source metadata header and the repeated backend-only scope wrapper are replaced
by the equivalent aggregate metadata and scope. Full member specifications were
preserved rather than shortening requirements to hit an arbitrary batch size.

## Parent-supervised security gate

Batch19 (gh-1086) is supervised and adjudicated by the parent controller under
explicit owner delegation. Independent review and actual technical evidence
remain required; there is no human-signature-only stop. The parent resolves
obsolete platform/deployment assumptions through recorded spec decisions and
never represents unperformed checks as a production PASS. See CONTROLLER.md and
`docs/adr/2026-10-31-owner-delegated-backend-program-supervision.md`.

## Execution protocol

1. Before the first implementation, reconcile the baseline, review the exact
   proposed aggregate specs and unresolved source approvals, then record owner
   approval using the existing issue CLI. Approval and queueing are separate.
   Do not queue held or external-gate work for an ordinary implementation worker.
2. Freeze the current batch issue hash, source hashes and base commit. Read its
   predecessor's completion handover, all embedded requirements and required
   topic skills. Run the structural verifier below before proceeding.
3. One implementation agent owns writes. Sequential specialist handoffs are
   allowed; no parallel worktrees or concurrent source writers. Write the named
   tests while implementing the combined Tasks. Use targeted checks and commits
   as development checkpoints, without per-source full verification/review gates.
4. Once the entire batch is implemented, freeze its candidate SHA. Independent
   reviewers check correctness/security, production wiring and all AC. They may
   read concurrently, but write reports only in separate thread-storage files.
   Use the relevant platform review-rules. Source Task/Out-of-scope conflicts
   must be named explicitly instead of silently reinterpreted.
5. One writer fixes confirmed findings. Re-review changed behavior and rerun
   affected evidence. Do not change unrelated code to make the pipeline green.
6. Run the full backend `pnpm run verify` and batch functional scenarios on the
   final candidate. Prove the API/storage/queue/worker paths required by the
   specifications, including applicable permissions, tenant isolation,
   concurrency, idempotency and fresh/populated-tenant migrations. Fakes prove
   deterministic provider contracts; mandatory live-provider AC need their own
   authorized evidence. No web/mobile code, builds or checks belong to this lane.
7. Maintain one evidence row per source AC: source ID, exact criterion,
   production entry point, implementation SHA, test/scenario, command/log path
   and PASS/FAIL/BLOCKED/NOT RUN. Check every criterion; no sampling. There must
   be no unresolved medium-or-higher review findings and no claimed PASS for a
   missing service or unrun criterion.
8. Only after the complete batch gate passes, use the existing guarded
   `issues.mjs complete` operation for the approved aggregate and each approved
   source, with a separate handover per record. Use the verified implementation
   commit; do not weaken completion guards. Re-run catalog/plan validation and
   commit the metadata. Completing a batch does not automatically complete its
   source records. This is a manual coordinator step, not a capability added to
   the legacy Relay worker by these issue edits.
9. Start the next batch only after predecessor completion and its handover.
   Stop on a failure or external gate; the scheduler does not repeatedly choose
   between feature epics or rediscover blockers. Update feature-epic completion
   only when every required backend child has passed or has an explicit owner
   deferral. Do not mark deferred client work implemented.

## Validation

Run from the repository root:

```sh
node issues/batches/backend/verify.mjs
node --test issues/batches/backend/verify.test.mjs
node .github/scripts/issues.mjs validate
```

The read-only verifier checks complete unique routing, source and batch hashes,
embedded source snapshots, parent preservation, dispatch suppression, member and
batch order, external completed handovers and the human security gate. It works
before implementation and after guarded completion because labels/state are
separate from the frozen source specifications. New or changed source specs
require an explicit manifest/spec update. Historical catalog diagnostics remain
reported by the ordinary validator; they are not silently repaired by batching.

## Main sequence

| Step | Canonical implementation issue | Source issues | Body characters |
|---:|---|---:|---:|
| 1 | [[backend-delivery 01/74] Implement application, data/chokePoint, data/inbox changes](../../items/sp-2e74b5af-826d-4fd5-ba38-1ba5e3f3f461.md) | 7 | 56364 |
| 2 | [[backend-delivery 02/74] Implement data/manifest, module-registry, application changes](../../items/sp-0017cb26-7b96-4820-bf97-96772881a9b0.md) | 7 | 55496 |
| 3 | [[backend-delivery 03/74] Implement architecture changes](../../items/sp-de4e31d4-fe70-40d1-9529-f2e486077657.md) | 11 | 57214 |
| 4 | [[backend-delivery 04/74] Implement data/inbox, data/chokePoint, data/tenancy changes](../../items/sp-6d23d3a0-de0d-4daf-afa5-0a6851a77b70.md) | 11 | 57513 |
| 5 | [[backend-delivery 05/74] Implement data/mail, data/tenancy, queue changes](../../items/sp-498bed5d-cf6d-440e-afe9-d926a167232a.md) | 10 | 57620 |
| 6 | [[backend-delivery 06/74] Implement agent-runtime, semprec-agents, data/agentRuns changes](../../items/sp-cf3300f1-216a-4f23-b35a-32ed074552d0.md) | 9 | 57781 |
| 7 | [[backend-delivery 07/74] Implement data/blobs, data/chokePoint, application changes](../../items/sp-fa7d01cf-279f-41e6-a0ab-f63701f998e3.md) | 8 | 57539 |
| 8 | [[backend-delivery 08/74] Implement data/mcp, data/notifications, data/push changes](../../items/sp-f1ddb03e-a6ec-486e-818d-56c7101ab2a0.md) | 11 | 56612 |
| 9 | [[backend-delivery 09/74] Implement data/inbox, data/transcription, semprec-transcribe changes](../../items/sp-6ae4040a-6669-4c5d-b236-3e20eb9fb477.md) | 11 | 59446 |
| 10 | [[backend-delivery 10/74] Implement ai-gateway-client, semprec-ai-gateway, shared changes](../../items/sp-ea66e986-936d-4135-ac13-d49d81e64540.md) | 10 | 59877 |
| 11 | [[backend-delivery 11/74] Implement data/chokePoint, data/tasks changes](../../items/sp-aeb88605-77ac-4921-a8b1-3f259c52ecf4.md) | 7 | 59979 |
| 12 | [[backend-delivery 12/74] Implement data/aiGateway, data/scheduler, data/agentRuns changes](../../items/sp-44a1d0e0-66ca-4dbe-947a-6602d9e44b5a.md) | 11 | 57567 |
| 13 | [[backend-delivery 13/74] Implement data/mail, semprec-api/adapter changes](../../items/sp-de8ab38c-761c-4ec7-b5f5-e7a7f4207af7.md) | 12 | 56211 |
| 14 | [[backend-delivery 14/74] Implement data/views, data/chokePoint, shared/genericOperations changes](../../items/sp-bbaffb18-fc40-4d14-a793-18f5554b7171.md) | 12 | 57910 |
| 15 | [[backend-delivery 15/74] Implement agent-runtime, semprec-agents, application changes](../../items/sp-144a2408-c4a8-4b9f-b68b-a5eec527dba7.md) | 10 | 56100 |
| 16 | [[backend-delivery 16/74] Implement architecture, data/auth, realtime changes](../../items/sp-e02ff8c6-d20d-4fde-be2a-e0033cf9ef91.md) | 10 | 57430 |
| 17 | [[backend-delivery 17/74] Implement data/mail, data/inbox, semprec-api/adapter changes](../../items/sp-db5e1165-5ccf-4fba-bce0-fd7a1f2bc098.md) | 11 | 55538 |
| 18 | [[backend-delivery 18/74] Implement data/mail, data/observability, data/docs changes](../../items/sp-a0bbb89b-34c7-4d8e-8758-3552b91c85a5.md) | 9 | 46516 |
| 19 | [[backend-delivery 19/74] Accept local security repairs and retain the production release gate](../../items/sp-f1a0629b-0137-4cd3-a7b7-9421ec0dc438.md) | 5 | 33722 |
| 20 | [[backend-delivery 20/74] Implement data/tenancy, data/auth, data/inbox changes](../../items/sp-823fc8d3-3186-4b22-9c0b-3e360048d9d3.md) | 7 | 55757 |
| 21 | [[backend-delivery 21/74] Implement data/mail, data/inbox, data/transcription changes](../../items/sp-3f9fb92f-ea6b-468c-8243-1fb711c94aa7.md) | 11 | 59916 |
| 22 | [[backend-delivery 22/74] Implement application, data/chokePoint, shared/genericOperations changes](../../items/sp-0a8b4be1-3039-4f6d-87b4-e1b673eab967.md) | 7 | 59348 |
| 23 | [[backend-delivery 23/74] Implement data/inbox, data/chokePoint, application changes](../../items/sp-10dd52f3-6bf6-481a-9f7d-14dece9c5e1e.md) | 9 | 59951 |
| 24 | [[backend-delivery 24/74] Implement data/chokePoint, data/projects, module-registry changes](../../items/sp-534ed947-bd78-4bb4-aacb-737a414a57d0.md) | 10 | 59894 |
| 25 | [[backend-delivery 25/74] Implement data/journal, data/mail, data/docs changes](../../items/sp-c057efef-e07e-4a64-86c8-303526adcf3e.md) | 10 | 59983 |
| 26 | [[backend-delivery 26/74] Implement data/tasks, application/projectAgentGuidance, data/guidanceDrift changes](../../items/sp-55495258-ecea-4313-a8ff-863910f68f23.md) | 7 | 59898 |
| 27 | [[backend-delivery 27/74] Implement data/chokePoint, data/derived, data/mail changes](../../items/sp-71e6d1cf-1d2d-44f9-aa27-fa5e9557cc57.md) | 9 | 59944 |
| 28 | [[backend-delivery 28/74] Implement data/mail, data/transcription, semprec-transcribe changes](../../items/sp-4d935482-f3ce-4604-aeed-b447d1fed82c.md) | 8 | 59996 |
| 29 | [[backend-delivery 29/74] Implement data/library, semprec-transcribe, queue changes](../../items/sp-77c2a124-6206-4790-ae09-a222243339dc.md) | 9 | 59924 |
| 30 | [[backend-delivery 30/74] Implement application, shared/genericOperations, data/chokePoint changes](../../items/sp-c7d74d78-a59f-4453-b2d6-3c9c31f8b235.md) | 8 | 59891 |
| 31 | [[backend-delivery 31/74] Implement semprec-agents, data/semp, queue changes](../../items/sp-7cce8a1c-44bb-4290-9d85-64dfbac693a0.md) | 9 | 59832 |
| 32 | [[backend-delivery 32/74] Implement data/inbox, data/semp, semprec-agents changes](../../items/sp-3c22fa5a-50b2-4eba-a22b-61220f6289dd.md) | 11 | 59819 |
| 33 | [[backend-delivery 33/74] Implement data/calendar, data/chokePoint, data/views changes](../../items/sp-1385289a-c057-4dcf-a42f-b2aaded63f7b.md) | 8 | 57306 |
| 34 | [[backend-delivery 34/74] Implement data/tasks, data/journal, data/chokePoint changes](../../items/sp-cc9b4e18-de0c-4fbd-aab3-85d5b5be52c8.md) | 10 | 56551 |
| 35 | [[backend-delivery 35/74] Implement data/chokePoint, data/transcription, data/mail changes](../../items/sp-9f67b277-1c75-4496-8571-5686097ff725.md) | 10 | 58247 |
| 36 | [[backend-delivery 36/74] Implement data/manifest, data/auth, data/library changes](../../items/sp-579f26a4-c5bf-4ea7-8b68-3c50cecf192b.md) | 8 | 55429 |
| 37 | [[backend-delivery 37/74] Implement data/tasks, data/calendar, data/chokePoint changes](../../items/sp-72e8758a-f119-48d3-b09f-122a1f1babef.md) | 10 | 57693 |
| 38 | [[backend-delivery 38/74] Implement data/docs, shared/genericOperations, application changes](../../items/sp-56a14b69-eb0e-4aa9-b024-3f0780d6f0ba.md) | 9 | 55339 |
| 39 | [[backend-delivery 39/74] Implement data/inbox, data/tasks, data/chokePoint changes](../../items/sp-ca8f8805-3e10-4be4-bf24-689cc8c840c7.md) | 9 | 54619 |
| 40 | [[backend-delivery 40/74] Implement data/mail, data/transcription, data/manifest changes](../../items/sp-36136548-e5b0-4c76-a0e6-d765c19b08bb.md) | 12 | 57845 |
| 41 | [[backend-delivery 41/74] Implement data/transcription, application, data/chokePoint changes](../../items/sp-4885858c-3b75-4b03-a181-e5e29e451101.md) | 8 | 54345 |
| 42 | [[backend-delivery 42/74] Implement data/notifications, data/push, data/sleep changes](../../items/sp-1601c9f8-0a3e-473e-9370-1c47f71ad0aa.md) | 9 | 55584 |
| 43 | [[backend-delivery 43/74] Implement data/auth, data/tasks, application changes](../../items/sp-5afb1625-a609-4f21-a3a0-b2d5e4bd554c.md) | 8 | 57154 |
| 44 | [[backend-delivery 44/74] Implement data/docs, application, data/journal changes](../../items/sp-00ebafd8-da78-4b44-983f-6f9705c28a6c.md) | 10 | 57389 |
| 45 | [[backend-delivery 45/74] Implement data/mail, data/agentRuns, data/mcp changes](../../items/sp-d2ba0da1-0737-4141-92e2-5c5afcb30f90.md) | 10 | 54554 |
| 46 | [[backend-delivery 46/74] Implement data/calendar, application, data/tasks changes](../../items/sp-836a321e-e717-4f96-a2e6-c1a236ee5b59.md) | 8 | 56642 |
| 47 | [[backend-delivery 47/74] Implement application, data/mcp, data/docs changes](../../items/sp-bea1bfc2-3e62-4290-af28-7818fa1e2b3a.md) | 7 | 57203 |
| 48 | [[backend-delivery 48/74] Implement data/calendar, data/mcp, data/tasks changes](../../items/sp-767c0955-daf8-4edd-882e-3eac16846fc3.md) | 9 | 56954 |
| 49 | [[backend-delivery 49/74] Implement data/chokePoint, data/sleep, data/tasks changes](../../items/sp-48013c73-79f6-41ee-9bec-990c39e2647e.md) | 8 | 57211 |
| 50 | [[backend-delivery 50/74] Implement application, shared/genericOperations, data/agentGrants changes](../../items/sp-9ea90977-e3d2-48ae-bdb1-fa0c1decd6f7.md) | 10 | 57255 |
| 51 | [[backend-delivery 51/74] Implement data/calendar, data/tasks changes](../../items/sp-75c1b975-fd26-4662-a40a-f40d02177d8a.md) | 9 | 56143 |
| 52 | [[backend-delivery 52/74] Implement agent-runtime, data/agentRuns, agent-runtime/tools changes](../../items/sp-8ef85048-a887-4f5b-bfca-a524601d48ad.md) | 10 | 56580 |
| 53 | [[backend-delivery 53/74] Implement data/transcription, semprec-transcribe, data/inbox changes](../../items/sp-404ad782-8ff8-4a64-80b4-a29fdf333e36.md) | 7 | 53845 |
| 54 | [[backend-delivery 54/74] Implement realtime, realtime-client, ai-gateway changes](../../items/sp-16d8729d-031f-4384-91f0-9fb7eaa8326b.md) | 9 | 54873 |
| 55 | [[backend-delivery 55/74] Implement data/agentRuns, data/mcp, data/semp changes](../../items/sp-f1428e6a-2200-476f-8115-7cc16ec8104f.md) | 8 | 57805 |
| 56 | [[backend-delivery 56/74] Implement data/semp, semprec-agents, application/projectAgentGuidance changes](../../items/sp-9f4aa1e3-40d6-4408-bc51-577c8bbbef38.md) | 8 | 54477 |
| 57 | [[backend-delivery 57/74] Implement data/mcp, realtime, realtime-client changes](../../items/sp-8822ea9b-25c6-44b8-8504-5d5af7654c0e.md) | 10 | 57344 |
| 58 | [[backend-delivery 58/74] Implement data/sleep, data/chokePoint, application changes](../../items/sp-e851d02d-f9e9-4d46-8d74-399d757d4b2d.md) | 7 | 53327 |
| 59 | [[backend-delivery 59/74] Implement data/calendar, data/chokePoint, data/search changes](../../items/sp-b01c7b1d-a5d0-4404-935f-b0455ab2aed1.md) | 9 | 55960 |
| 60 | [[backend-delivery 60/74] Implement data/chokePoint, data/inbox, data/transcription changes](../../items/sp-c085d86f-fed6-4d7c-b983-a73c72d95223.md) | 9 | 57495 |
| 61 | [[backend-delivery 61/74] Implement data/mail, data/search, shared/genericOperations changes](../../items/sp-2f2ffdd3-af61-4d7f-b072-a54ddd4dab8a.md) | 10 | 55657 |
| 62 | [[backend-delivery 62/74] Implement data/chokePoint, data/calendar, data/trash changes](../../items/sp-b5e18c99-27b0-4479-8882-bdaf0fbe9a72.md) | 9 | 57775 |
| 63 | [[backend-delivery 63/74] Implement data/mail, data/inbox, semprec-api/adapter changes](../../items/sp-559d3b2a-9178-4247-b9e1-67ece8a18fa4.md) | 11 | 57790 |
| 64 | [[backend-delivery 64/74] Implement data/inbox, data/calendar, data/manifest changes](../../items/sp-cc56c645-b2de-4ad5-82fb-c907011425d6.md) | 8 | 55053 |
| 65 | [[backend-delivery 65/74] Implement data/chokePoint, data/agentRuns, data/scheduler changes](../../items/sp-f8cc252b-49f1-4b64-a6a2-4c65839ea3b3.md) | 8 | 57900 |
| 66 | [[backend-delivery 66/74] Implement data/mail, data/inbox, data/semp changes](../../items/sp-e039076f-0c82-4f3e-90ca-37a813ebcd28.md) | 11 | 55316 |
| 67 | [[backend-delivery 67/74] Implement data/calendar, data/semp, agent-runtime changes](../../items/sp-5848d216-b194-4bdb-9afb-e05c4d3a0fb6.md) | 7 | 54126 |
| 68 | [[backend-delivery 68/74] Implement data/calendar, data/inbox, data/notifications changes](../../items/sp-4c05dd52-f9eb-4474-92d0-feaf5c252da2.md) | 7 | 54226 |
| 69 | [[backend-delivery 69/74] Implement data/calendar, queue, data/chokePoint changes](../../items/sp-d2796d07-70a9-4c60-b951-e0062c704e5d.md) | 7 | 54419 |
| 70 | [[backend-delivery 70/74] Implement data/inbox, data/blobs, data/docs changes](../../items/sp-e1a8e572-15ed-4568-b9be-33e76f66d8af.md) | 9 | 55996 |
| 71 | [[backend-delivery 71/74] Implement data/inbox, data/transcription, semprec-transcribe changes](../../items/sp-9c059097-487d-4e51-950d-2ea975f0ed08.md) | 7 | 55908 |
| 72 | [[backend-delivery 72/74] Implement data/calendar, data/inbox, data/docs changes](../../items/sp-3ccbdb63-4e68-4015-aa44-4dff162d1e91.md) | 9 | 58514 |
| 73 | [[backend-delivery 73/74] Implement data/inbox, data/mcp, queue changes](../../items/sp-56893bf7-2d28-48ba-bc63-2129e44d82bd.md) | 9 | 57226 |
| 74 | [[backend-delivery 74/74] Implement data/inbox, data/mcp, data/recipes changes](../../items/sp-c4a4aa37-b11e-47da-8b15-4931b712b71d.md) | 9 | 52239 |

## Held work

These records are outside the main chain and have no execution authorization.
They preserve the deferrals rather than pretending the client work is complete.

| Step | Canonical issue | Source issues | Body characters |
|---|---|---:|---:|
| Held | [[backend-held 1/2] Resolve [mt-go-live 03/03] Add the invitation acceptance page](../../items/sp-bdd77f36-8455-4ccf-b861-fe913749fb21.md) | 1 | 5119 |
| Held | [[backend-held 2/2] Resolve [agent-md 04/07] Switch the web AGENT page to the guidance API and remove projects.agents](../../items/sp-0f2c4b83-7f3f-429c-8a7a-fb50cfad5086.md) | 1 | 5383 |

## Local continuation and production release gates

Owner instruction 2026-11-03 and
[the continuation ADR](../../../docs/adr/2026-11-03-local-development-continues-with-open-production-gates.md)
separate local acceptance from live production authorization. Batch 19 retains
all five source snapshots/routing, completes its four local corrective sources
and aggregate under the recorded parent decision, and leaves gh-1086 OPEN as
a production/release gate. Its unavailable external evidence does not halt
subsequent authorized local batches. No production check is waived or passed
by this sequencing exception; original requirements and held client scope
remain preserved. See [the exact decision](decisions/batch-19-local-continuation.md).
