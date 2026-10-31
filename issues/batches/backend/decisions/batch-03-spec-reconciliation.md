# Parent adjudication — batch 03

Authority: explicit owner delegation to parent thr_pz39tcih5r for autonomous backend program decisions.

- gh-1366: retain the accepted shared/block-model/ pure package already consumed by backend, with no pg/Node-only dependency; the docs/blocks.ts legacy API is not the new model. No move, duplicate package, client implementation or workspace restructuring is authorized. Recognize the actual accepted ADR and valid backend/web/mobile metadata without editing its historical body.
- gh-1371: retain OpenAI TTS as a provisional engineering default, with no invented Czech comparative result. A real ten-passage/two-listener qualification remains a condition before production release and is tracked explicitly by gh-1399; it does not block local backend engineering completion. Engineering tests and external perceptual qualification are distinct. No live provider call or production release is authorized.
- gh-1371/1372: add one shared accepted backend-only voice reconciliation ADR linking the two historical accepted records and gateway/budget decisions. This supplies the missing cross-reference and clarifies the provisional status without editing either historical body/frontmatter or falsely claiming a result.
- gh-1399 and its future batch 10 snapshot were updated now so the qualification cannot disappear between batches. Its acceptance receipt must explicitly carry NOT RUN until actual listening evidence exists; backend completion is distinct from deployment qualification. Batch 10 remains unapproved for dispatch.

- gh-1366: 0ca3cc3e305ceafdb4e4f91f1eca968eb06f1fd8a7a21a4c6484d23637dc5cf7 -> 27090644ccda62858a38f08411214907c3a22f5ff21a7ac85522178689139531
- gh-1371: f3d6ee82132325aad6a7f8de88f3a3399c637934864427737d3602594a643c03 -> 61438a75daead149ec59c2b4182a86810c39b92961e0dd5c308eade84cc9d401
- gh-1372: 6830421b129d3dfe3dc062708f58a3f89a6b1dd3124525c99938819e5512960f -> 7a5685cc47f8155714da272c016041ba865f7dd2e43edc8f286862bc61144816
- gh-1399: c612336ede34bfbd4933c0d726a2d291f9b59cb22e19cd67892ce7f7d7d9cdad -> 5f487d699e93606f37da211b84aa73c3fce48525d1ba0034ef9ef3d315aa33c0

## Complete block/page rationale and honest release-condition reporting

Independent review identified absent mandatory alternatives/trade-offs in historical block decisions 6-8 and page-family decisions 5-8. Retain the complete requirements and supply one new accepted backend-only docs/adr/2026-10-31-block-and-page-decision-rationale.md, referencing both original ADRs, with no runtime/client/API/storage/approval change. It records present reasoning, not invented historical deliberations. Final evidence must map all eight decisions in each source across original record and addendum. Original accepted historical bodies remain unchanged.

The same addendum records the existing backend workspace inclusion of ../shared/block-model with workspace:* as a narrowly updated consumption choice; the pure package remains outside backend, and no root/web workspace, lockfile or client restructuring is authorized. This resolves the concrete low finding instead of moving already working code.

The listening qualification is a documented pre-production-release condition, not an implemented automatic release gate. Acceptance evidence must disclose that distinction. No releases.md, automation or production deployment change is authorized in this documentation-only batch. Local completion with explicit NOT RUN remains allowed; actual listening evidence must never be invented.

- gh-1366: 27090644ccda62858a38f08411214907c3a22f5ff21a7ac85522178689139531 -> a941e6d314c86e065e23f5f48743874748c4eb987bba3abc75fa02aac9ae823f
- gh-1394: c03cd367906ff2496b48d801d68b5abb4e119dda781cefc690e8c6a289e43477 -> 012d08fd455746d94304ae5cc0ed5cecb5f32b82620296abd353097a4b48bd82
Aggregate: aa747622930fe193aac849f89348bde3e393bbdaed235033db435ff0192e58bf.
