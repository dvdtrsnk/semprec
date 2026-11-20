package cz.semprec.app.domain.note

/** Words and link addresses, for formatting without a selection and for the link dialog. */
object NoteWords {

    /**
     * The word around [offset], for formatting without a selection: `null` at the edge of a word or outside one,
     * where the format applies to the text typed next instead.
     */
    fun wordAround(text: String, offset: Int): IntRange? {
        val inside = offset in 1 until text.length &&
            text[offset - 1].isLetterOrDigit() && text[offset].isLetterOrDigit()
        if (!inside) return null
        var start = offset
        while (start > 0 && text[start - 1].isLetterOrDigit()) start -= 1
        var end = offset
        while (end < text.length && text[end].isLetterOrDigit()) end += 1
        return start until end
    }

    /** A link address with a scheme: `https://` in front of one typed without. */
    fun linkAddress(typed: String): String {
        val trimmed = typed.trim()
        return if (SCHEME.containsMatchIn(trimmed)) trimmed else "https://$trimmed"
    }

    private val SCHEME = Regex("^[A-Za-z][A-Za-z0-9+.-]*:")
}
