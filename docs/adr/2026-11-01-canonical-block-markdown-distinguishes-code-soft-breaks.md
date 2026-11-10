---
status: accepted
date: 2026-11-01
area: [backend, web, mobile]
supersedes: []
superseded-by: null
---

# Canonical block Markdown distinguishes code-marked soft breaks

## Context

[[2026-10-28-block-model-for-page-documents]] stores inline attributes on Y.Text, including on LF. [[2026-11-01-canonical-block-markdown-preserves-content-whitespace]] retains LF as a soft break and keeps entities literal in fenced code. The recovered serializer splits code text at LF and emits a bare `<br>` between fenced pieces, losing only that character's code attribute. An LF alone loses its only mark. Inferring code from neighboring fences would instead corrupt a genuinely unmarked LF between two code text spans.

This decision extends that earlier ADR's LF representation only. It does not change any accepted historical body, stored model, schema, ordinary inline code, entity semantics or client implementation. General HTML code parsing, allowing physical multiline canonical blocks and dropping valid marks are rejected.

## Decision

- Ordinary LF remains `<br>`. A code-marked LF serializes as the exact lowercase inline atom `<code><br></code>`, representing exactly one LF with `code: true`. Adjacent/consecutive breaks retain each character's distinct marks. Ordinary code text remains in the existing backtick fence form.
- The inline parser recognizes this exact atom only outside fenced code, after structural block parsing. It is not an opening/closing code state and introduces no general HTML `<code>` grammar, attributes, aliases or arbitrary nesting. Flush preceding plain text before producing the code-marked LF, and preserve the active outer bold/italic/link marks on it. Following plain text must not inherit code merely because the atom occurred.
- Existing escape handling preserves literal atom-looking plain text; do not rescan escaped characters or accumulated buffers. Fenced code is consumed as literal content: `<br>`, `<code><br></code>` and whitespace references inside its fence stay literal characters. Do not infer code from two neighboring fenced spans or decode HTML/entities inside them.
- Keep ordinary/bold soft-break canonical samples, block markers, list indentation, inline link destination disambiguation, whitespace escaping, ID comments, unknown types, empty-block semantics and page policy. Formatting and href attributes around the new atom must round-trip by semantic Y.Text delta, not merely by flattened visible text.

## Other inline line characters

Only LF separates physical block lines. Interior CR, U+2028 and U+2029 remain content, including inside fenced code. Structural heading/list/todo/quote content captures must accept them on the already LF-split input rather than falling back to text or dropping characters. Use an all-character/non-LF capture or equivalent on that input; do not create another physical-line splitter, alter raw CRLF normalization, broaden the marker grammar, or change structural indentation. Existing boundary-whitespace encoding still applies at content boundaries.

## Consequences and verification

This is a narrow addition to gh-1608's shared canonical format and fixtures. No dependency, general HTML support, data rewrite, migration or client build is included. Future format consumers must use the same parser/serializer.

Permanent actual Y.Text and shared-vector controls cover code-only LF; LF between, before and after code text; consecutive LF; mixed marked/unmarked breaks, especially an unmarked LF between two code spans; outer bold/italic/link combinations; literal `<br>` and the whole atom inside code; escaped plain atom-looking text; comments/withIds and preserved unknown types. Assert exact semantic marks/text/href, stable canonical reserialization and unchanged ordinary soft-break output. The prior whitespace/code padding/literal entity cases remain required. This architectural choice is not implementation evidence, whole-review clearance or a final gate result.

For interior CR/U+2028/U+2029, test actual h2, quote and indented-list Y.Text with and without code marks, exact type/text/marks/indent, stable canonical reserialization, and ordinary LF block separation/soft-break/blank-line/marker/CRLF controls. These are preservation tests for valid existing inputs, not a new stored format for line characters.
