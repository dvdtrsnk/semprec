package cz.semprec.app.data

import cz.semprec.app.domain.MailBox
import cz.semprec.app.domain.MailFacetOption
import cz.semprec.app.domain.MailFacets
import cz.semprec.app.domain.MailNamedRef
import cz.semprec.app.domain.MailOutcome
import cz.semprec.app.domain.MailRepository
import cz.semprec.app.domain.MailSummary
import cz.semprec.app.domain.MailThreadChanges
import cz.semprec.app.domain.MailThreadChangesRepository
import cz.semprec.app.domain.MailThreadDetail
import cz.semprec.app.domain.MailThreadPage
import cz.semprec.app.domain.MailThreadQuery
import cz.semprec.app.domain.RepositoryResult
import cz.semprec.app.domain.map
import cz.semprec.app.domain.then
import io.ktor.http.HttpMethod
import io.ktor.http.encodeURLPathPart

private const val PAGE_LIMIT = "50"
private const val EMPTY_BODY = "{}"
private const val PROJECTS_KEY = "projects"

/**
 * The mail reads and thread actions of `/api/mail/threads*` (the list's changes since a cursor included), `/api/mail/summary` and `/api/mail/contacts`. The names
 * and colors of the projects in the filter are read as items, because the counts carry only their ids. A
 * read mark, flag or move refused with a known code is [MailOutcome.Refused].
 */
class HttpMailRepository internal constructor(
    private val api: AuthenticatedApi,
    private val items: ItemsApi,
) : MailRepository, MailThreadChangesRepository {
    constructor(api: AuthenticatedApi) : this(api, ItemsApi(api))

    override suspend fun threads(query: MailThreadQuery): RepositoryResult<MailThreadPage> {
        val parameters = buildList {
            addAll(query.viewParameters())
            add("limit" to PAGE_LIMIT)
            query.search.trim().takeIf(String::isNotEmpty)?.let { add("q" to it) }
            query.cursor?.let { add("cursor" to it) }
        }
        return api.send(HttpMethod.Get, "/api/mail/threads", parameters).decode<MailThreadPageDto>()
            .map { page -> MailThreadPage(page.threads.map { it.toDomain() }, page.nextCursor, page.changesCursor) }
    }

    override suspend fun threadChanges(query: MailThreadQuery, since: String): RepositoryResult<MailThreadChanges> =
        api.send(HttpMethod.Get, "/api/mail/threads/changes", query.viewParameters() + ("since" to since))
            .decode<MailThreadChangesDto>()
            .map { changes ->
                MailThreadChanges(changes.cursor, changes.threads.map { it.toDomain() }, changes.removed, changes.reset)
            }

    override suspend fun facets(projectId: String?): RepositoryResult<MailFacets> {
        val parameters = listOfNotNull(projectId?.let { "projectId" to it })
        return api.send(HttpMethod.Get, "/api/mail/threads/facets", parameters).decode<MailFacetsDto>()
            .then { counts -> names(PROJECTS_KEY).map { projectNames -> counts.toDomain(projectNames, projectId) } }
    }

    override suspend fun summary(): RepositoryResult<MailSummary> =
        api.send(HttpMethod.Get, "/api/mail/summary").decode<MailSummaryDto>().map { it.toDomain() }

    override suspend fun thread(threadId: String): RepositoryResult<MailThreadDetail> =
        api.send(HttpMethod.Get, "/api/mail/threads/${threadId.encodeURLPathPart()}")
            .decode<MailThreadDetailDto>().map { it.toDomain() }

    override suspend fun setRead(threadId: String, read: Boolean): RepositoryResult<MailOutcome<Boolean>> =
        api.send(HttpMethod.Post, "${threadPath(threadId)}/read", body = flagBody("read", read))
            .mailOutcome { decode<MailReadDto>().map { it.unread } }

    override suspend fun setFlagged(threadId: String, flagged: Boolean): RepositoryResult<MailOutcome<Boolean>> =
        api.send(HttpMethod.Post, "${threadPath(threadId)}/flag", body = flagBody("flagged", flagged))
            .mailOutcome { decode<MailFlagDto>().map { it.flagged } }

    override suspend fun archive(threadId: String): RepositoryResult<MailOutcome<Unit>> = move(threadId, "archive")

    override suspend fun trash(threadId: String): RepositoryResult<MailOutcome<Unit>> = move(threadId, "trash")

    override suspend fun restore(threadId: String): RepositoryResult<MailOutcome<Unit>> = move(threadId, "restore")

    override suspend fun createTask(threadId: String): RepositoryResult<MailNamedRef> =
        api.send(HttpMethod.Post, "${threadPath(threadId)}/tasks", body = EMPTY_BODY)
            .decode<MailTaskCreatedDto>().map { MailNamedRef(it.id, it.name) }

    private suspend fun move(threadId: String, action: String): RepositoryResult<MailOutcome<Unit>> =
        api.send(HttpMethod.Post, "${threadPath(threadId)}/$action", body = EMPTY_BODY).mailOutcome { ignoreBody() }

    /** The name and color of every item of the system database [key], by id. */
    private suspend fun names(key: String): RepositoryResult<Map<String, MailNameAndColor>> =
        items.databaseId(key).then { id -> items.queryAll(id, ItemQuery()) }.map { all ->
            all.associate { it.id to MailNameAndColor(it.properties.text("name"), it.properties.text("color")) }
        }
}

private data class MailNameAndColor(val name: String?, val color: String?)

/** The filters that name the list view, as the list and its changes take them. */
private fun MailThreadQuery.viewParameters(): List<Pair<String, String>> = buildList {
    add("box" to box.wire())
    mailboxId?.let { add("mailboxId" to it) }
    folderId?.let { add("folderId" to it) }
    projectId?.let { add("projectId" to it) }
    if (unreadOnly) add("unread" to "true")
}

private fun threadPath(threadId: String) = "/api/mail/threads/${threadId.encodeURLPathPart()}"

private fun flagBody(key: String, value: Boolean) = "{\"$key\":$value}"

private fun MailBox.wire(): String = when (this) {
    MailBox.INBOX -> "inbox"
    MailBox.FLAGGED -> "flagged"
    MailBox.SEMP_DRAFTS -> "sempDrafts"
}

/** The options of the filter; one whose item is gone or has no name is left out, as it could not be shown. */
private fun MailFacetsDto.toDomain(
    projectNames: Map<String, MailNameAndColor>,
    selectedProjectId: String?,
) = MailFacets(
    total = total,
    projectsTotal = projects.total,
    projects = projects.items.mapNotNull { item -> item.option(projectNames) },
    selectedProjectName = selectedProjectId?.let { projectNames[it]?.name },
)

private fun MailFacetItemDto.option(names: Map<String, MailNameAndColor>): MailFacetOption? {
    val known = names[id] ?: return null
    return known.name?.let { MailFacetOption(id, it, known.color, count) }
}
