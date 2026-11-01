---
status: accepted
date: 2026-11-01
area: [backend, web, mobile]
supersedes: []
superseded-by: null
---

# Canonical block Markdown preserves significant content whitespace

## Context

[[2026-10-28-block-model-for-page-documents]] makes Y.Text the stored inline model and assigns its Markdown format to gh-1608. The format uses nonempty physical lines as blocks and blank lines as separators. Valid stored text can nevertheless start/end with spaces or tabs, or consist entirely of whitespace. The recovered serializer emits these characters literally and its parser trims/discards them, losing valid model content. A historical handover acknowledging normalization does not waive the issue's model round-trip requirement.

Removing all line trimming alone cannot distinguish a whitespace-only content block from a separator and can alter list indentation and marker parsing. Rejecting valid Y.Text values changes the stored model. A general HTML parser, new block metadata payload or separate JSON text format is unnecessary. This decision adds a small explicit whitespace escape to the existing line-oriented inline syntax. It changes no Yjs schema and does not implement client consumers or repair historical data.

## Decision

- Preserve significant leading/trailing whitespace of each block's inline content, including whitespace-only content, through canonical serialize/parse. Structural indentation, a marker's required separator and blank separator lines are not content. Normal unescaped Markdown may retain the current outer-whitespace normalization; its raw blank/space-only lines remain separators. Serialization must encode content that would otherwise be lost, rather than claiming every raw whitespace line is a block.
- Outside inline code, encode boundary whitespace using numeric references `&#xH;`, where H is the Unicode scalar's lowercase hexadecimal code point without leading zeros: space is `&#x20;`, tab `&#x9;`, CR `&#xd;`. Recognize only references whose value is an ECMAScript `\s` character other than LF; LF retains the existing `<br>` soft-break representation. Interior ordinary spaces remain literal so existing normal canonical examples do not change. Whitespace-only content encodes every character. Do not encode a block's structural list indent or its marker separator.
- Decode this narrow canonical reference form only in the inline-text parser after block-marker/blank-line classification, never as a preprocessing step that could turn decoded content into a structural marker. Do not add general HTML/entity decoding. Noncanonical, malformed, non-whitespace and invalid scalar references remain literal text under existing rules; no permissive numeric conversion or arbitrary entity interpretation is introduced.
- A literal text sequence that would otherwise be recognized as a whitespace reference must serialize with its ampersand escaped by the existing backslash punctuation mechanism, e.g. `\&#x20;`. Escape handling consumes that ampersand as literal and must not decode the resulting buffer a second time. Preserve genuine reference-looking user text and avoid double decoding. Existing escaped backslashes remain reversible.
- Preserve inline marks and hrefs on whitespace and adjacent text. Entities inside an inline-code span remain literal code, never decoded. Use the existing code-span/fence padding convention reversibly when code content has literal boundary spaces; do not substitute entities for code characters or strip meaningful spaces. Test all-whitespace code and code with both leading/trailing spaces as well as ordinary code.
- Apply content preservation to text, quote and other text-bearing blocks, including headings/lists and preserved unknown types, without changing block type, list indentation or done state. Comment/withIds mode does not change text semantics. Actual empty-string blocks and the synthetic empty document keep their existing distinct contracts. `stripMarkdown` keeps its existing plain-text joining/truncation policy; this is not a requirement to retain its outer separator whitespace.

Canonical inline `semprec://page/` links separately use the already supported angle destination form, while actual page blocks retain their unwrapped standalone syntax. Neither disambiguation requires changing the stored model or reinterpreting historical raw Markdown as if its original block kind were known. Accepted historical ADR bodies remain unchanged.

## Consequences and verification

The escape is part of gh-1608's shared canonical format and fixture contract; future consumers must use the same parser/serializer. No library, migration, production data rewrite or client implementation/build is included. This adds representation for valid content rather than making a previously invalid model value writable.

Permanent shared vectors and actual Y.Text composition tests must cover leading/trailing spaces, tabs, CR and another whitespace scalar stripped by current trim; whitespace-only and empty text; quote and list/heading content versus structural indent; formatting/link attributes; inline code boundary/all-whitespace content; literal reference-looking text, escaped ampersand/backslash and invalid/non-whitespace reference controls; comments/withIds and unknown types; blank separators, ordinary page blocks and the existing project-notes exact-output example. Assert exact semantic round trips and canonical fixed points, not just flattened display text. Keep LF soft breaks and independent page-link tests. Tests and independent review must check that decoding cannot turn inline text into a block marker. This decision is not evidence that an implementation or final gate passed.
