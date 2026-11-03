# Batch 19 initial security-review disposition

Authority: owner-delegated parent controller `thr_pz39tcih5r`, under the accepted owner-delegated backend program supervision decision. This records findings and scopes proposed corrections; it is not security acceptance, source implementation authorization, production access or permission to advance past batch 19.

## Provenance and finite review

One complete initial independent R1 reviewed clean commit `7550fba23bcd86cc963287797d2ec07ed8832c13`, tree `7d763b49dc881ccfb8210deb664015681b3aacbd`. The full report SHA-256 is `b9335aeacd8ff9f9929a142a22762420e52a4ab61954540785fbd0af4b77c5f7`; its original partial remains unchanged at `29f4b4aee1981dfc1b1318f64902cf900aa7b7666243cafc6013745cca866994`. R1 is COMPLETE as a bounded static audit, NOT CLEAR. It ran no tests or production checks and explicitly released its read window. Requested Terra/xhigh configuration is distinct from the exposed GPT-6 identity; no variant attestation or human signature is fabricated.

Preserve all reviewed source/approval identities and original handovers. The initial report is not reclassified as CLEAR after a repair. At most one SAME-reviewer focused R2 remains, with exact changed-byte and unchanged-source ledger reconciliation. There is no automatic third review. A feasibility/design consultation by an implementation specialist is not independent review and cannot grant CLEAR or consume/restart this budget.

## Confirmed recovery defects

Parent source inspection confirms F1, F2 and F3 under the exact triggers in R1:

- F1: restore activation precedes handling a replay refusal; a refused recorded deletion leaves that tenant unchanged. Services must remain offline until replay succeeds; last-admin and status refusals are preserved.
- F2: a newer key backup can contain a key whose tenant is absent from an older main snapshot, causing the direct key restore's FK failure. Key import requires an explicit compatible-key boundary, not a FK bypass or an older-key fallback that defeats shredding.
- F3: the main dump snapshot and later ledger query can observe a concurrent purge differently. A newer replay ledger is useful; it cannot silently be discarded or misrepresented as the same-snapshot equality evidence.

Gh-1086 excludes code changes and requires failed items to have their own issues. Four separately identified corrective requirements are added to batch 19 before gh-1086: native packaging `sp-62b97861-bb73-46ec-83d7-2dcfd881b16a` (F5), restore activation `sp-a0f046dd-8781-4141-bc04-5dad0b725faf` (F1), compatible key recovery `sp-94a5c71d-4663-4014-9256-db63e179346e` (F2), and dump/ledger semantics `sp-dd171464-d76c-45f9-b113-73d81b38aad4` (F3). Their parent remains the tenancy feature epic. Each retains its own Task, Touches, scope, AC, approval and eventual completion guard. The aggregate's exact union covers their work without changing gh-1086's docs-only member scope. Gh-1086 explicitly depends on all four; no source is queued independently.

These are necessary corrective additions to the owner-authorized program, not replacement or waiver of an original requirement. The manifest has 669 sources: all 665 original requirements plus four additions, still 74 main batches and two held client batches. The original members, identities and requirements of every other batch remain unchanged. The verifier's real-plan count assertion is synchronized to this explicit inventory; no verifier predicate or negative test is weakened. The first draft creation exposed section-order and unassigned-source diagnostics; their failed outputs remain in controller storage. Correct section ordering and explicit checked routing repair the metadata rather than bypassing the validators.

The four new requirements and enlarged aggregate remain proposed and unqueued until their concrete protocols and exact source paths are pinned and approved by the parent. Read-only feasibility work is allowed now. Before source implementation, record a supported key-import/dump-ledger/native-resolution design in an append-only ADR and update exact snapshots/hashes/approvals. No ad hoc package-manifest rewrite, production environment workaround, target FK disable, arbitrary SQL dump rewrite, automatic snapshot fallback, new recovery lease or silent recovery algorithm is authorized by a draft.

## F4: bounded deployment verifier

Accept F4 as an explicit limitation of the eight predicates actually specified by gh-1085. The implementation follows that earlier contract; it does not prove exact policy expressions, helper bodies or all effective grants after privileged manual drift. No current installed isolation bypass or public exploit was demonstrated. Do not change correct earlier code solely to imply a universal verifier.

Production security acceptance still needs actual effective catalog/policy/grant evidence in addition to the narrow verifier output. This written limitation is not a production PASS, an acceptance of an observed permissive live policy, or permission to ignore a future concrete drift finding. A broader continuously enforced invariant verifier would need its own explicitly scoped requirement.

## F5/F6 and current gate status

Native runtime module resolution remains the historical observed prerequisite; the new F5 requirement owns its bounded repair. Historical full-load CLI DROP timeouts and unproved individual database removal are retained accurately. Do not infer their cause or retroactive settlement from global PostgreSQL shutdown, a later passing summary, or a test-only resolver.

The last actual full verify, on batch18 candidate a468446a, remains FAIL with the exact MCP environment-name mismatch. Its local integration exception does not transfer to batch19. No fresh verify was run for this initial security/docs candidate. The exact final gate/diagnosis will be selected only after the concrete repair candidate exists; no repeated verification campaign or environment workaround is authorized here.

The earlier owner waivers of gh-1058/1068 do not waive gh-1086. Historical docs permit implementation before second-tenant production sign-off, whereas the currently approved batch19 criteria hold sequential advancement. This conflict remains explicit and not silently resolved. Current source already includes the recovered guard-drop migration and invitation route; the absent index cannot be described as physically preventing a second tenant in a fully migrated local database. No deployment, invitation, production backup access, production restore or go-live authorization is granted. Production and unavailable checks stay NOT RUN/BLOCKED. Gh-1086, the aggregate, and advancement remain open/held pending explicit later disposition.
