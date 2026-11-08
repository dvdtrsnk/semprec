---
status: accepted
date: 2026-11-01
area: [backend, web, mobile]
supersedes: []
superseded-by: null
---

# Canonical page blocks encode identifiers and captions

## Context

[[2026-10-28-block-model-for-page-documents]] accepts a nonempty JavaScript string as a page block's pageId. Gh-1608 renders an actual page as a standalone unwrapped `semprec://page/` link and intentionally discards its caption on parse. Existing serialization emits pageId verbatim; accepted IDs containing space fail the page matcher, and LF splits the output into different blocks. A resolver title containing LF similarly splits a page with an otherwise safe ID. Owned actual-model diagnostics established both outcomes; they deliberately assert the defects, not a passing product contract.

[[2026-11-01-canonical-inline-link-destinations-escape-line-feeds]] explicitly concerns inline hrefs and leaves this separate pageId grammar for adjudication. The content-whitespace and code-softbreak ADRs likewise do not encode an identifier. This addition preserves the stored model and existing standalone page/inline-link distinction. Restricting IDs to UUIDs, rejecting previously valid strings, or treating the page as an ordinary inline link is rejected. UTF-8 percent encoding alone can throw on an accepted unpaired UTF-16 surrogate; a general URI parser/entity decoder is unnecessary.

## Decision

### Opaque page-ID suffix

- Preserve the standalone shape `[Title](semprec://page/ENCODED_ID)`. An original UTF-16 code unit in ASCII `[A-Za-z0-9._~-]` is emitted unchanged. Emit every other original code unit as exactly six ASCII characters: backslash, lowercase `u`, then four uppercase hexadecimal digits with leading zeros. Space becomes `\u0020`, LF `\u000A`, `)` becomes `\u0029`, and an original backslash becomes `\u005C`. Ordinary UUIDs and `p1` therefore keep their existing exact output.
- Iterate original UTF-16 code units. Encode both units of a supplementary character separately and preserve an unpaired surrogate as its own escaped unit. This is an opaque block-format identifier codec, not Unicode normalization, URI percent encoding or an extra model validation rule. The nonempty requirement is unchanged.
- After recognizing an actual standalone page block, decode only exact `\uHHHH` tokens with uppercase hexadecimal digits in its captured ID suffix. Emit the corresponding code unit and advance past the original token once. Do not rescan output. Other captured characters remain literal, and there is no percent/entity/inline-href decoding. A literal escape-looking ID is preserved because its original backslash was itself encoded; the decoded backslash is never interpreted again.
- This suffix codec is confined to the page block's pageId. Do not apply it to inline href strings, link labels, comment/block IDs or arbitrary text. Keep angle-destination inline page hrefs as inline links under their separate contract. Reserved new escape syntax cannot reveal the original model of a historical raw string; do not perform historical repairs or claim byte-preserving interpretation of ambiguous old raw escapes. Current canonical output must be unambiguous and reversible.

### Resolver caption

- Serialize the resolver's string as existing inline **plain text** inside the page caption, using the same escaping/whitespace and ordinary soft-break representation as a plain text run without attributes. In particular a resolver LF emits `<br>` instead of a physical LF. Literal `<br>`, backslashes, brackets and Markdown-looking text remain escaped literal characters rather than injected formatting or links. Empty title still emits an empty caption.
- The actual page parser continues discarding the caption, as the original contract specifies; do not introduce stored page-title fields, rename behavior, title rejection or whitespace normalization to solve this representation issue. `stripMarkdown` keeps its existing visible-label joining/truncation policy. Re-serialization uses the caller's resolver again; do not claim that parsing stores its caption.

## Consequences and verification

No Yjs schema/model change, dependency, migration, client implementation/build or raw-history rewrite is included. The permanent shared parser/serializer and fixtures own this exact encoding; a consumer must use the decoded pageId, not assume the opaque canonical suffix is the stored ID or run a generic URL decoder over it. Historical accepted ADR bodies remain unchanged.

Use actual Y.Doc/writeBlock/readPageBlocks inputs for safe IDs, whitespace-only IDs, interior/edge/consecutive LF, CR/tab/Unicode whitespace, closing/opening delimiters, original backslashes and escape-looking strings, percent/entity-looking strings, non-ASCII/supplementary characters and unpaired surrogate units. Assert exact page type/pageId, one physical output line, both ID-comment modes, allowPage true/false, ordinary safe-page bytes, and canonical fixed points with a deterministic resolver. Test lowercase/invalid/noncanonical raw escape controls according to the narrow decoder, never a broad regex replacement that can decode its own output twice.

Resolver controls include LF-only and mixed LF, CR/U+2028/U+2029, brackets, literal `<br>`, backticks and Markdown-looking text, with safe and encoded IDs. Assert preservation of the page, intentional caption discard, visible-label behavior and stable output when the same resolver is supplied again. Keep inline href LF/reference, whitespace and code-LF tests green. The earlier negative diagnostic logs remain historical failures; this decision accepts no implementation or final gate.
