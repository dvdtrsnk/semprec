package cz.semprec.app.domain

/** The segments whose text or speaker contains [query], case ignored; a blank query keeps them all. */
fun List<TranscriptSegment>.matching(query: String): List<TranscriptSegment> {
    val wanted = query.trim().lowercase()
    if (wanted.isEmpty()) return this
    return filter { wanted in it.text.lowercase() || wanted in it.label.lowercase() }
}

/** The index (a [TranscriptSegment.index]) of the segment being spoken at [position] seconds, or `null` before any. */
fun List<TranscriptSegment>.activeAt(position: Double): Int? =
    lastOrNull { it.startsAt <= position }?.index
