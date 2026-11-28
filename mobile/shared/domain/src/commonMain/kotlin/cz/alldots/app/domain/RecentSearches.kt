package cz.alldots.app.domain

private const val MAX_RECENT_SEARCHES = 5

/** The searches the person made lately, most recent first. */
interface RecentSearches {
    fun list(): List<String>

    /** Remembers [query] as the most recent search, forgetting an equal one and any beyond the fifth. */
    fun remember(query: String)
}

/** Recent searches kept for the lifetime of the object. */
class InMemoryRecentSearches : RecentSearches {
    private var queries: List<String> = emptyList()

    override fun list(): List<String> = queries

    override fun remember(query: String) {
        val key = foldForSearch(query)
        queries = (listOf(query) + queries.filter { foldForSearch(it) != key }).take(MAX_RECENT_SEARCHES)
    }
}

/** Remembers a search once it is worth keeping: a blank one is not. */
class RememberRecentSearch(private val recents: RecentSearches) {
    operator fun invoke(query: String) {
        val text = query.trim()
        if (text.isNotEmpty()) recents.remember(text)
    }
}

private const val WITH_MARKS = "áàâäãå" + "čć" + "ď" + "éèêëě" + "íìîï" + "ňń" + "óòôöõ" +
    "ř" + "šś" + "ť" + "úùûüů" + "ýÿ" + "žźż"
private const val WITHOUT_MARKS = "aaaaaa" + "cc" + "d" + "eeeee" + "iiii" + "nn" + "ooooo" +
    "r" + "ss" + "t" + "uuuuu" + "yy" + "zzz"

/** Lower case without the marks of Latin letters, so that "Půlmaraton" and "pulmaraton" are one search. */
fun foldForSearch(text: String): String = buildString {
    for (character in text.trim().lowercase()) {
        val index = WITH_MARKS.indexOf(character)
        append(if (index >= 0) WITHOUT_MARKS[index] else character)
    }
}
