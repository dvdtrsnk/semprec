package cz.semprec.app.data

import io.ktor.http.HttpMethod

/**
 * The reads of the offline set: the requests whose answers [OfflineLayer] keeps on the device
 * (docs/adr/2026-11-23-mobile-keeps-the-answers-of-the-offline-set.md). Mail, files, recordings, transcripts, search,
 * Semp, the account and the session are not among them, so their reads always go to the server.
 */
internal object OfflineRoutes {
    private val keptGets: List<Regex> = listOf(
        "/api/schema",
        "/api/databases",
        "/api/items/[^/]+",
        "/api/items/[^/]+/related",
        "/api/items/[^/]+/page",
        "/api/calendar/timeline",
        "/api/calendar/agenda",
        "/api/calendar/reminders",
        "/api/badge-counts",
        "/api/journal/periods/[^/]+/[^/]+",
        "/api/overview",
        "/api/sleep/nights",
        "/api/inbox/cards",
        "/api/inbox/cards/count",
        "/api/inbox-types",
    ).map(::route)

    private val keptPosts: List<Regex> = listOf(
        "/api/databases/[^/]+/query",
        "/api/databases/[^/]+/facets",
    ).map(::route)

    /** Whether the answer of [method] on [path] (without its query) belongs to the offline set. */
    fun keeps(method: HttpMethod, path: String): Boolean {
        val route = path.substringBefore('?')
        return when (method) {
            HttpMethod.Get -> keptGets.any { it.matches(route) }
            HttpMethod.Post -> keptPosts.any { it.matches(route) }
            else -> false
        }
    }

    /**
     * Whether a successful [method] on [path] may have changed a kept answer: every request a screen announces
     * ([AuthenticatedApi.announces]) and the saving of a page's text, which the diary's period answer shows. The
     * history upload of a mailbox changes nothing kept, and it runs every few seconds while it lasts.
     */
    fun changesKept(method: HttpMethod, path: String): Boolean {
        val route = path.substringBefore('?')
        val savesPageText = method != HttpMethod.Get && method != HttpMethod.Head &&
            (route.endsWith("/page.md") || route.endsWith("/doc"))
        return AuthenticatedApi.announces(method, path) || savesPageText
    }

    private fun route(pattern: String) = Regex("^$pattern$")
}
