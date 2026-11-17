---
status: accepted
date: 2026-11-01
area: [backend, web, mobile]
supersedes: []
superseded-by: null
---

# Canonical inline link destinations escape line feeds

## Context

[[2026-10-28-block-model-for-page-documents]] stores a nonempty href string on Y.Text. The shared model accepts LF inside that string. Gh-1608's canonical Markdown uses LF as a physical block boundary; emitting an accepted href's LF literally therefore splits its inline link before destination parsing. Rejecting that stored model value, dropping its link or percent-encoding its LF into a different href does not preserve the declared conversion.

[[2026-11-01-canonical-block-markdown-preserves-content-whitespace]] defines narrow references in inline content and deliberately excludes LF there. [[2026-11-01-canonical-block-markdown-distinguishes-code-soft-breaks]] distinguishes content soft breaks and code literals. Neither decision encodes a destination's LF. This addition is confined to angle-bracket inline destinations; their existing backslash escapes already distinguish literal delimiters. Historical accepted bodies remain unchanged.

## Decision

- Serialize any inline href containing LF using a single physical-line angle destination. Replace each original LF with the exact ASCII sequence `&#xa;`. Example: a destination whose value is `a`, LF, `b` has angle contents `a&#xa;b`. Inline page hrefs continue using angle form; actual standalone page-block syntax is unchanged.
- Preserve the existing escapes for original backslashes and angle delimiters in angle destinations. If the original href contains the literal sequence `&#xa;`, escape its ampersand as `\&` when emitting angle form, producing `\&#xa;`. Do not re-escape a newly emitted LF token. Serialize original characters in one pass or an equivalent implementation that demonstrably does not confuse original literal text with generated syntax.
- In the angle-destination parser only, consume an existing backslash escape as literal first. Otherwise decode an exact unescaped lowercase `&#xa;` as one LF. Decode once while advancing over the input; do not decode an accumulated result or a decoded escape again. Uppercase, padded, decimal, invalid and other entity-looking strings remain literal destination text. No general HTML/entity decoder, URI percent transformation or normalization is added.
- Bare destinations retain their existing output and interpretation. A literal `&#xa;` in a bare destination remains literal; the reserved decoding is angle-only. Preserve ordinary destination output, current scheme defaulting, link text/marks, destination punctuation/backslashes and the distinction between inline page hrefs and actual page blocks. This is not new URL admission policy or a data migration.
- Content parsing, numeric whitespace references, code-LF atoms and fenced literals remain separate. A destination LF does not become a content soft break or another block, and `&#xa;` inside fenced code remains literal. No library, Yjs schema change, historical raw-string repair, client implementation or client build is included.

## Consequences and verification

Permanent actual Y.Text and shared canonical vectors cover schemed hrefs containing leading/interior/trailing and consecutive LF, including inline page hrefs; literal `&#xa;` with and without LF, original backslashes next to it, escaped angle delimiters, other numeric-looking references and ordinary bare/angle destinations. Check both page policies and ID modes, exact semantic href/text/marks, one physical output block line, and stable canonical reserialization. Keep ordinary page, scheme-defaulting, content whitespace, code-LF and literal code controls. These tests must discriminate one-pass decoding and preserve exact literal contents, not merely link display text.

The rule concerns inline href strings. It does not claim a new encoding or validation contract for a page block's separate pageId field, nor infer an old raw Markdown string's original model. A separately confirmed in-scope pageId representability defect requires its own explicit assessment rather than silently extending this escape into page-block grammar. This decision alone clears no implementation or final gate.
