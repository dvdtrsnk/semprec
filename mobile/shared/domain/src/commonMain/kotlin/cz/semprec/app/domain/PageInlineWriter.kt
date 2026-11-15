package cz.semprec.app.domain

private enum class SpanKind { LINK, BOLD, ITALIC }

private class Piece(val isBreak: Boolean, val text: String, val run: InlineRun)

private class Span(val kind: SpanKind, val start: Int, var end: Int, val href: String, var html: Boolean = false)

/**
 * Writes typed runs as the canonical inline Markdown, the inverse of [PageInlineParser]: a port of
 * `serializeInline` of `shared/block-model`. It is used only for a block the person edited; every other block
 * keeps the exact text the server sent.
 */
object PageInlineWriter {
    fun serialize(runs: List<InlineRun>): String {
        val pieces = toPieces(runs)
        val spans = buildSpans(pieces)
        markHtmlSpans(spans, pieces)
        val offsets = mutableListOf<Int>()
        val whole = StringBuilder()
        for (piece in pieces) {
            offsets += whole.length
            whole.append(if (piece.isBreak) "\n" else piece.text)
        }
        offsets += whole.length
        val whole0 = whole.toString()
        val italicTokens = spans.filter { it.kind == SpanKind.ITALIC }.associateWith {
            italicToken(it, whole0.getOrNull(offsets[it.start] - 1), whole0.getOrNull(offsets[it.end]))
        }
        val out = StringBuilder()
        for (index in 0..pieces.size) {
            closing(spans, index).forEach { out.append(closeToken(it, italicTokens)) }
            opening(spans, index).forEach { out.append(openToken(it, italicTokens)) }
            pieces.getOrNull(index)?.let { out.append(writePiece(it, offsets[index], whole0)) }
        }
        return out.toString()
    }

    private fun toPieces(runs: List<InlineRun>): List<Piece> {
        val pieces = mutableListOf<Piece>()
        for (run in runs) {
            val segments = run.text.split("\n")
            segments.forEachIndexed { index, segment ->
                if (segment.isNotEmpty()) pieces += Piece(false, segment, run)
                if (index < segments.lastIndex) pieces += Piece(true, "", run)
            }
        }
        return pieces
    }

    private fun buildSpans(pieces: List<Piece>): List<Span> {
        val spans = mutableListOf<Span>()
        fun collect(kind: SpanKind, applies: (InlineRun) -> Boolean) {
            var current: Span? = null
            pieces.forEachIndexed { index, piece ->
                val active = current
                if (!applies(piece.run)) {
                    current = null
                } else if (active != null && active.href == (piece.run.link ?: "")) {
                    active.end = index + 1
                } else {
                    current = Span(kind, index, index + 1, piece.run.link ?: "").also { spans += it }
                }
            }
        }
        collect(SpanKind.LINK) { it.link != null }
        collect(SpanKind.BOLD) { it.bold }
        collect(SpanKind.ITALIC) { it.italic }
        return spans
    }

    private fun markHtmlSpans(spans: List<Span>, pieces: List<Piece>) {
        val formatting = spans.filter { it.kind != SpanKind.LINK }
        for (span in formatting) {
            val text = pieces.subList(span.start, span.end).joinToString("") { it.text }
            if (text.isEmpty() || text.first().isWhitespace() || text.last().isWhitespace()) span.html = true
        }
        for (a in formatting) {
            for (b in formatting) {
                if (a.start < b.start && b.start < a.end && a.end < b.end) {
                    a.html = true
                    b.html = true
                }
            }
        }
    }

    private fun closing(spans: List<Span>, index: Int): List<Span> = spans.filter { it.end == index }
        .sortedWith(compareByDescending<Span> { it.start }.thenByDescending { it.kind.ordinal })

    private fun opening(spans: List<Span>, index: Int): List<Span> = spans.filter { it.start == index }
        .sortedWith(compareByDescending<Span> { it.end }.thenBy { it.kind.ordinal })

    private fun italicToken(span: Span, before: Char?, after: Char?): String {
        val inWord = PageInlineSyntax.isWordChar(before) || PageInlineSyntax.isWordChar(after)
        return if (span.html) "<em>" else if (inWord) "*" else "_"
    }

    private fun openToken(span: Span, italic: Map<Span, String>): String = when (span.kind) {
        SpanKind.LINK -> "["
        SpanKind.BOLD -> if (span.html) "<strong>" else "**"
        SpanKind.ITALIC -> italic.getValue(span)
    }

    private fun closeToken(span: Span, italic: Map<Span, String>): String = when (span.kind) {
        SpanKind.LINK -> "](${PageInlineEscaping.linkDestination(span.href)})"
        else -> openToken(span, italic).let { if (it.startsWith("<")) "</" + it.substring(1) else it }
    }

    private fun writePiece(piece: Piece, offset: Int, whole: String): String = when {
        piece.isBreak -> if (piece.run.code) "<code><br></code>" else "<br>"
        piece.run.code -> PageInlineEscaping.codeSpan(piece.text)
        else -> PageInlineEscaping.escapePlain(piece.text, offset, whole)
    }
}
