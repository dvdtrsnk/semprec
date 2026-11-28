package cz.alldots.app.data

import io.ktor.http.HttpMethod

/**
 * The reads of the offline set: the requests whose answers [OfflineLayer] keeps on the device
 * (docs/adr/2026-11-23-mobile-answers-from-the-device-at-once-and-reads-again-behind.md). Mail, files, recordings, transcripts, search,
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
}

/**
 * The writes of the offline set that wait in the queue without a connection
 * (docs/adr/2026-11-23-mobile-writes-wait-in-an-ordered-queue-without-a-connection.md). [template] names the route
 * without its ids, as a recorded failure shows it; [createsId] tells that the write creates something whose id the
 * device makes up until the server answers. Every other write goes to the server as before, and so does
 * `POST /api/calendar/items/:id/duplicate`, which the server cannot recognize when it is sent twice.
 */
internal enum class QueuedRoute(
    val method: HttpMethod,
    pattern: String,
    val template: String,
    val createsId: Boolean = false,
) {
    CREATE_ITEM(HttpMethod.Post, "/api/databases/[^/]+/items", "POST /api/databases/:id/items", createsId = true),
    PATCH_ITEM(HttpMethod.Patch, "/api/items/[^/]+", "PATCH /api/items/:id"),
    DELETE_ITEM(HttpMethod.Delete, "/api/items/[^/]+", "DELETE /api/items/:id"),
    SET_RELATION(HttpMethod.Put, "/api/items/[^/]+/relations/[^/]+", "PUT /api/items/:id/relations/:key"),
    ADD_RELATION(
        HttpMethod.Put,
        "/api/items/[^/]+/relations/[^/]+/[^/]+",
        "PUT /api/items/:id/relations/:key/:target",
    ),
    REMOVE_RELATION(
        HttpMethod.Delete,
        "/api/items/[^/]+/relations/[^/]+/[^/]+",
        "DELETE /api/items/:id/relations/:key/:target",
    ),
    VALUE_LINK(HttpMethod.Post, "/api/items/[^/]+/links/[^/]+/[^/]+", "POST /api/items/:id/links/:key/:action"),
    OCCURRENCE(
        HttpMethod.Post,
        "/api/(events|tasks)/series/[^/]+/occurrences/[^/]+",
        "POST /api/:family/series/:id/occurrences/:date",
        createsId = true,
    ),
    SET_TASK_RECURRENCE(HttpMethod.Put, "/api/tasks/[^/]+/recurrence", "PUT /api/tasks/:id/recurrence"),
    CLEAR_TASK_RECURRENCE(HttpMethod.Delete, "/api/tasks/[^/]+/recurrence", "DELETE /api/tasks/:id/recurrence"),
    HOST_EVENT(HttpMethod.Put, "/api/tasks/[^/]+/host-events/[^/]+", "PUT /api/tasks/:id/host-events/:event"),
    INVITATION_ANSWER(
        HttpMethod.Post,
        "/api/calendar/invitations/[^/]+/respond",
        "POST /api/calendar/invitations/:id/respond",
    ),
    INBOX_CAPTURE(HttpMethod.Post, "/api/inbox/items", "POST /api/inbox/items"),
    PERIOD_PAGE(
        HttpMethod.Put,
        "/api/journal/periods/[^/]+/[^/]+/doc",
        "PUT /api/journal/periods/:type/:period/doc",
        createsId = true,
    ),
    ;

    private val regex = route(pattern)

    companion object {
        /** The queued route of [method] on [path] (without its query), or `null` for a write that is not queued. */
        fun of(method: HttpMethod, path: String): QueuedRoute? {
            val route = path.substringBefore('?')
            return entries.firstOrNull { it.method == method && it.regex.matches(route) }
        }
    }
}

private fun route(pattern: String) = Regex("^$pattern$")
