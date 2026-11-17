---
status: accepted
date: 2026-11-01
area: [backend, web, mobile]
supersedes: []
superseded-by: null
---

# Canonical block comments preserve identifiers and unknown types

## Context

Gh-1608's optional ID comments let an agent address the same block it read. The shared model accepts nonempty string IDs, but the recovered serializer sanitizes `a b` into `a_b`, changing identity and colliding with a distinct accepted ID. The public serializer also accepts a string type and promises preservation of unknown types, while the recovered formatter similarly changes `we ird` into `we_ird`.

[[2026-11-01-canonical-page-blocks-encode-identifiers-and-captions]] deliberately confines its lossless UTF-16 codec to pageId. This new decision authorizes the same algorithm, with a comment-specific safe alphabet, for the separate `id` and `type` comment field values. It changes neither that historical body nor stored model validation. Rejecting accepted IDs or silently normalizing public unknown type strings is rejected; a general quoted/JSON attribute grammar or another metadata payload is unnecessary.

## Decision

- Keep the existing `semprec:block` comment shape and unchanged `indent` handling. In each emitted `id` or `type` field, preserve ASCII `[A-Za-z0-9._:~-]` code units literally. Colon preserves existing safe comment-key output. Encode every other original UTF-16 code unit as backslash, lowercase `u`, and four uppercase hexadecimal digits, including the original backslash, whitespace, quotes, equals sign, angle delimiters and non-ASCII units. No token can introduce another attribute, a physical LF or a comment terminator.
- Decode exact uppercase-hex `\uHHHH` tokens once in these field values only. Never rescan decoded output or apply URL/percent/entity decoding. Literal escape-looking strings remain distinct because their original backslash was encoded. Safe IDs and known type names remain byte-identical; `a b` stays distinct from `a_b`. Do not sanitize or normalize the decoded ID before duplicate handling.
- Valid model block IDs remain nonempty. The synthetic null-ID block keeps its existing skip behavior. Preserve existing policy on when a comment is emitted: `withIds` emits every physical block's ID, and mandatory preservation/empty comments retain their existing triggers. A default text block without an emitted comment still gets an ID from the existing parser generator. Only actual equal decoded IDs invoke the existing duplicate-ID replacement policy.
- Unknown type values in the public serializer/parsed representation preserve their exact string, not only an identifier-shaped whitelist. This includes spaces, punctuation, escape-looking text, Unicode and unpaired units. Represent the empty unknown type with the exact raw token `type=""`: two literal quotes are a dedicated empty-value sentinel, not general quoted parsing. A nonempty literal quote string encodes its quote units and cannot collide with that sentinel. The sentinel is type-only; it does not introduce an empty valid model ID.
- Retain existing parser precedence: known block markers determine known block type; an unknown decoded comment type applies only where the existing unknown-preservation rule applies to plain content or a pending empty block. Do not use a comment to override a page/heading/list marker or create a page without pageId. Keep the readPageBlocks reader's documented normalization of remote unknown types unchanged. The serializer's explicit unknown strings and parsed preservation representation do not register new writable types; normal writeBlock registry checks still apply.
- Do not apply this comment-field contract to pageId, inline hrefs, captions or arbitrary text. Their separate codecs remain scoped. Raw new escape syntax is reserved; do not infer or repair the original meaning of ambiguous historical raw comments. No stored-data rewrite, migration, library, client implementation or client build is included.

## Consequences and verification

Use actual Y.Doc/writeBlock/readPageBlocks with valid nonempty IDs, including collisions between `a b` and `a_b`, delimiters, backslashes and escape-looking text, LF/whitespace, Unicode/supplementary and unpaired units. Assert exact IDs on ordinary and page blocks, canonical comment fixed points, safe old output, both comment modes and actual duplicate handling. Demonstrate that comment fields cannot inject fields or close the comment.

For unknown types, test the public serializer and parser directly with `we ird`, `we_ird`, unsafe/whitespace/empty/quote/Unicode strings and literal escape tokens. Do not fabricate a supposedly valid production writeBlock unknown type: the stored reader still normalizes and registry still refuses unknown writes. Preserve plain content/indent, empty and nonempty bodies, known marker priority and actual page behavior. Test the type-only sentinel and a literal two-quote string separately, not a generic JSON decoder.

Keep source fixtures and previous identifier, inline-page, pageId/caption, destination LF, whitespace and code-LF cases. Exact semantic identity and canonical fixed points are required. This decision is format/scope authority, not a passing implementation or final gate result.
