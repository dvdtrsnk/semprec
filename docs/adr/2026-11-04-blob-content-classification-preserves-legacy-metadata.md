---
status: accepted
date: 2026-11-04
area: [backend]
supersedes: []
superseded-by: null
---

# Keep verified blob classification separate from legacy MIME metadata

## Context

Gh-1661 creates Files items after standalone upload. Historical blob mime_type can be caller-declared, and content-hash dedup deliberately preserves that row's existing metadata. Treating every historical MIME as detected content misclassifies a new Files item; rewriting the legacy MIME would violate dedup/read compatibility. A transform cannot perform storage I/O inside its item transaction. This extends [[2026-11-01-blob-reference-writes-coordinate-with-collection]] and [[2026-11-01-file-uploads-share-the-blob-filing-lock]] without changing blob identity or reference ownership.

## Decision

Add one nullable blobs.detected_mime_type text column through an additive migration. NULL means no verified result; application/octet-stream means the existing bounded detector observed unknown content. Do not backfill from mime_type, file extensions or client headers, add a bulk storage scan, or claim historical detection from a renamed field.

Only the existing fileUploadStore content-detection owner records this field after streaming and the existing bounded 64 KiB head read, before returning a successfully committed standalone upload or upload-to-Files result. Reuse the existing detector unchanged. On the same tenant-scoped transaction, take the existing checked blob row lock before recording detection for newly created or deduplicated bytes. Write only a previously NULL classification; known classifications are immutable under this decision. A dedup hit's freshly streamed, hashed identical bytes are sufficient evidence for a previously unclassified existing blob. Preserve its mime_type, storage key, content hash, byte size, created_at and all existing item properties/relations. Do not renew GC age. Keep the new column private to the blob owner rather than add it to public upload/read envelopes or allow callers to assert trusted detection through a generic createBlob input. Internal reads/writes remain typed, tenant-scoped and check affected rows.

The Files create-only omitted-type transform reads this verified field through the blob owner, never falls back to unverified mime_type and never reads storage. A missing verified result or unknown content adds no type; explicit caller type remains unchanged. The existing locked Files-select option check still governs any derived key. Old blobs remain readable/referenceable and unchanged; re-uploading identical bytes can provide missing evidence for future creates. Earlier Files items are never retroactively retyped. Existing references, GC and duplicate/new-byte cleanup keep their current owners and failure semantics.

For gh-1661, widen the existing standalone HTTP header admission from image-only to a syntactically valid required media type, including document and audio types and application/octet-stream. The header admits an upload but never determines classification. Keep authentication, streaming size limits, tenant dedup, status/envelope and no-item behavior. Malformed/missing headers still refuse before storage; unknown bytes remain acceptable and classify as unknown. Do not introduce a second upload route, converter or model/provider call.

## Consequences

A single additive field avoids corrupting legacy observations or opening storage from an item transaction. This deliberately narrows the earlier image-only admission when a later Files consumer needs other formats, and extends dedup with private verified evidence while preserving all pre-existing metadata and response fields. It is not a claim that every producer or historical blob has been verified.

Prove populated-schema NULL upgrade, new and deduplicated verified uploads, old incorrect MIME with unchanged legacy fields and earlier item/edges, unknown and unverified legacy omission, explicit-type preservation, tenant isolation, both existing blob/GC lock orders as affected, and actual authenticated PDF/audio/document standalone upload followed by compound item/project creation. Preserve size/malformed-header refusal and cancellation collection controls. Migration artifacts require source/direct-built parity after clean and repeat builds.
