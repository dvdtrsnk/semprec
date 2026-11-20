package cz.semprec.app.domain

/** The formats a span can carry, outermost first: where spans start or end together they nest in this order. */
private enum class SpanKind { LINK, COLOR, HIGHLIGHT, UNDERLINE, STRIKE, BOLD, ITALIC }

private class Piece(val isBreak: Boolean, val text: String, val run: InlineRun)

/** Pieces [start] until [end] carry [kind]; [value] is the link destination or the color key. */
private class Span(val kind: SpanKind, val start: Int, var end: Int, val value: String, var html: Boolean = false)

/** The value of [kind] on [run]: `null` when the run does not carry it, an empty string for a plain format. */
private fun spanValue(kind: SpanKind, run: InlineRun): String? = when (kind) {
    SpanKind.LINK -> run.link
    SpanKind.COLOR -> run.color?.key
    SpanKind.HIGHLIGHT -> run.highlight?.key
    SpanKind.UNDERLINE -> "".takeIf { run.underline }
    SpanKind.STRIKE -> "".takeIf { run.strike }
    SpanKind.BOLD -> "".takeIf { run.bold }
    SpanKind.ITALIC -> "".takeIf { run.italic }
}

/**
 * Splits every span where a span of an outer kind, up to [SpanKind.STRIKE], starts or ends inside it, so those
 * formats always nest in [SpanKind] order. Bold and italic may still cross each other; they are then written as tags.
 */
private fun nestSpans(spans: List<Span>): List<Span> = spans.flatMap { span ->
    val inner = spans.asSequence()
        .filter { it.kind < span.kind && it.kind <= SpanKind.STRIKE }
        .flatMap { sequenceOf(it.start, it.end) }
        .filter { it > span.start && it < span.end }
        .distinct().sorted().toList()
    val starts: List<Int> = listOf(span.start) + inner
    starts.zip(inner + span.end) { start, end -> Span(span.kind, start, end, span.value) }
}

/**
 * Writes typed runs as the canonical inline Markdown, the inverse of [PageInlineParser]: a port of
 * `serializeInline` of `shared/block-model`. Formats nest outermost first as link, text color
 * (`<span data-color>`), highlight (`<mark data-color>`), underline (`<u>`), strikethrough (`~~`), bold, italic,
 * with code innermost. It is used only for a block the person edited; every other block keeps the exact text the
 * server sent.
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
        val strikeEdges = spans.filter { it.kind == SpanKind.STRIKE }.flatMap { listOf(it.start, it.end) }.toSet()
        val out = StringBuilder()
        for (index in 0..pieces.size) {
            closing(spans, index).forEach { out.append(closeToken(it, italicTokens)) }
            opening(spans, index).forEach { out.append(openToken(it, italicTokens)) }
            pieces.getOrNull(index)?.let {
                val edges = (index in strikeEdges) to (index + 1 in strikeEdges)
                out.append(writePiece(it, offsets[index], whole0, edges))
            }
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
        for (kind in SpanKind.entries) {
            var current: Span? = null
            pieces.forEachIndexed { index, piece ->
                val active = current
                val value = spanValue(kind, piece.run)
                if (value == null) {
                    current = null
                } else if (active != null && active.value == value) {
                    active.end = index + 1
                } else {
                    current = Span(kind, index, index + 1, value).also { spans += it }
                }
            }
        }
        return nestSpans(spans)
    }

    /** Bold and italic delimiters that would not read back (at whitespace, or crossing) are written as tags. */
    private fun markHtmlSpans(spans: List<Span>, pieces: List<Piece>) {
        val formatting = spans.filter { it.kind == SpanKind.BOLD || it.kind == SpanKind.ITALIC }
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
        SpanKind.COLOR -> "<span data-color=\"${span.value}\">"
        SpanKind.HIGHLIGHT -> "<mark data-color=\"${span.value}\">"
        SpanKind.UNDERLINE -> "<u>"
        SpanKind.STRIKE -> "~~"
        SpanKind.BOLD -> if (span.html) "<strong>" else "**"
        SpanKind.ITALIC -> italic.getValue(span)
    }

    private fun closeToken(span: Span, italic: Map<Span, String>): String = when (span.kind) {
        SpanKind.LINK -> "](${PageInlineEscaping.linkDestination(span.value)})"
        SpanKind.COLOR -> "</span>"
        SpanKind.HIGHLIGHT -> "</mark>"
        else -> openToken(span, italic).let { if (it.startsWith("<")) "</" + it.substring(1) else it }
    }

    /** [strikeEdges] says whether a `~~` delimiter is written right before and right after the piece. */
    private fun writePiece(piece: Piece, offset: Int, whole: String, strikeEdges: Pair<Boolean, Boolean>): String =
        when {
            piece.isBreak -> if (piece.run.code) "<code><br></code>" else "<br>"
            piece.run.code -> PageInlineEscaping.codeSpan(piece.text)
            else -> PageInlineEscaping.escapePlain(piece.text, offset, whole, strikeEdges.first, strikeEdges.second)
        }
}
