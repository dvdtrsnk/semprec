package cz.semprec.app.domain

import cz.semprec.app.core.MailSignalField

private const val MAX_DOMAINS = 50
private const val MAX_ADDRESSES = 100
private const val MAX_KEYWORDS = 50
private const val MAX_DOMAIN_INPUT_LENGTH = 2048
private const val MAX_HOST_LENGTH = 253
private const val MAX_ADDRESS_LENGTH = 320
private const val MAX_KEYWORD_LENGTH = 100
private val SCHEME = Regex("^[A-Za-z][A-Za-z0-9+.-]*://")
private val ADDRESS = Regex("^[^\\s@,]+@[^\\s@,]+$")
private val WHITESPACE = Regex("\\s+")

/** What adding a typed value to one list of the signals did. */
sealed interface MailSignalAddition {
    /** The value, normalized, is at the end of its list in [signals]. */
    data class Added(val signals: MailSignalSet) : MailSignalAddition

    /** The list already holds the value. */
    data object AlreadyThere : MailSignalAddition

    /** Nothing but whitespace was typed. */
    data object Blank : MailSignalAddition

    /** The value is not one the server keeps in that list, or the list is full. */
    data object Invalid : MailSignalAddition
}

/**
 * Adds a typed value to one list of the signals, normalized as the server normalizes it: a domain may be typed as a
 * URL or a bare host and is kept as its lower-case host without `www.`, and needs a dot; an address is trimmed and
 * lower-cased; a keyword is trimmed with its inner whitespace collapsed, needs a letter or digit, and is a duplicate
 * of another that differs only in case. The server checks again on save and preview, and its normalization wins.
 */
class AddMailSignal {
    operator fun invoke(signals: MailSignalSet, field: MailSignalField, typed: String): MailSignalAddition {
        val value = when (field) {
            MailSignalField.DOMAINS -> domain(typed)
            MailSignalField.ADDRESSES -> address(typed)
            MailSignalField.KEYWORDS -> keyword(typed)
        }
        val list = signals.values(field)
        return when {
            typed.isBlank() -> MailSignalAddition.Blank
            value == null -> MailSignalAddition.Invalid
            list.any { it.sameAs(value, field) } -> MailSignalAddition.AlreadyThere
            list.size >= limit(field) -> MailSignalAddition.Invalid
            else -> MailSignalAddition.Added(signals.with(field, list + value))
        }
    }

    private fun String.sameAs(other: String, field: MailSignalField) = when (field) {
        MailSignalField.KEYWORDS -> lowercase() == other.lowercase()
        MailSignalField.DOMAINS, MailSignalField.ADDRESSES -> this == other
    }

    private fun limit(field: MailSignalField) = when (field) {
        MailSignalField.DOMAINS -> MAX_DOMAINS
        MailSignalField.ADDRESSES -> MAX_ADDRESSES
        MailSignalField.KEYWORDS -> MAX_KEYWORDS
    }

    private fun domain(typed: String): String? {
        val text = typed.trim()
        if (text.length > MAX_DOMAIN_INPUT_LENGTH) return null
        val afterScheme = SCHEME.find(text)?.let { text.substring(it.range.last + 1) } ?: text
        val authority = afterScheme.takeWhile { it != '/' && it != '?' && it != '#' && it != '\\' }
        val host = authority.substringAfterLast('@').substringBefore(':')
            .lowercase()
            .removePrefix("www.")
            .removeSuffix(".")
        val wellFormed = host.isNotEmpty() &&
            host.first().isLetterOrDigit() &&
            host.last().isLetterOrDigit() &&
            host.all { it.isLetterOrDigit() || it == '.' || it == '-' }
        return host.takeIf { wellFormed && '.' in it && it.length <= MAX_HOST_LENGTH }
    }

    private fun address(typed: String): String? {
        val text = typed.trim()
        val valid = text.length <= MAX_ADDRESS_LENGTH && ADDRESS.matches(text) && text.none { it.isISOControl() }
        return text.lowercase().takeIf { valid }
    }

    private fun keyword(typed: String): String? {
        val text = typed.trim().replace(WHITESPACE, " ")
        return text.takeIf { it.length <= MAX_KEYWORD_LENGTH && it.any(Char::isLetterOrDigit) }
    }
}
