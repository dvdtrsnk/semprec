package cz.semprec.app.data

import cz.semprec.app.domain.MailBox
import cz.semprec.app.domain.MailFacetOption
import cz.semprec.app.domain.MailFacets
import cz.semprec.app.domain.MailNamedRef
import cz.semprec.app.domain.MailOutcome
import cz.semprec.app.domain.MailRepository
import cz.semprec.app.domain.MailSummary
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
private const val AREAS_KEY = "areas"
private const val PROJECTS_KEY = "projects"

/**
 * The mail reads and thread actions of `/api/mail/threads*`, `/api/mail/summary` and `/api/mail/contacts`. The names
 * and colors of the areas and projects in the filter are read as items, because the counts carry only their ids. A
 * read mark, flag or move refused with a known code is [MailOutcome.Refused].
 */
class HttpMailRepository internal constructor(
    private val api: AuthenticatedApi,
    private val items: ItemsApi,
) : MailRepository {
    constructor(api: AuthenticatedApi) : this(api, ItemsApi(api))

    override suspend fun threads(query: MailThreadQuery): RepositoryResult<MailThreadPage> {
        val parameters = buildList {
            add("box" to query.box.wire())
            add("limit" to PAGE_LIMIT)
            query.mailboxId?.let { add("mailboxId" to it) }
            query.folderId?.let { add("folderId" to it) }
            query.areaId?.let { add("areaId" to it) }
            query.projectId?.let { add("projectId" to it) }
            if (query.unreadOnly) add("unread" to "true")
            query.search.trim().takeIf(String::isNotEmpty)?.let { add("q" to it) }
            query.cursor?.let { add("cursor" to it) }
        }
        return api.send(HttpMethod.Get, "/api/mail/threads", parameters).decode<MailThreadPageDto>()
            .map { page -> MailThreadPage(page.threads.map { it.toDomain() }, page.nextCursor) }
    }

    override suspend fun facets(areaId: String?, projectId: String?): RepositoryResult<MailFacets> {
        val parameters = listOfNotNull(areaId?.let { "areaId" to it }, projectId?.let { "projectId" to it })
        return api.send(HttpMethod.Get, "/api/mail/threads/facets", parameters).decode<MailFacetsDto>()
            .then { counts ->
                names(AREAS_KEY).then { areaNames ->
                    names(PROJECTS_KEY).map { projectNames ->
                        counts.toDomain(areaNames, projectNames, areaId, projectId)
                    }
                }
            }
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

private fun threadPath(threadId: String) = "/api/mail/threads/${threadId.encodeURLPathPart()}"

private fun flagBody(key: String, value: Boolean) = "{\"$key\":$value}"

private fun MailBox.wire(): String = when (this) {
    MailBox.INBOX -> "inbox"
    MailBox.FLAGGED -> "flagged"
    MailBox.SEMP_DRAFTS -> "sempDrafts"
}

/** The options of the filter; one whose item is gone or has no name is left out, as it could not be shown. */
private fun MailFacetsDto.toDomain(
    areaNames: Map<String, MailNameAndColor>,
    projectNames: Map<String, MailNameAndColor>,
    selectedAreaId: String?,
    selectedProjectId: String?,
) = MailFacets(
    total = total,
    areasTotal = areas.total,
    projectsTotal = projects.total,
    areas = areas.items.mapNotNull { item -> item.option(areaNames) },
    projects = projects.items.mapNotNull { item -> item.option(projectNames) },
    selectedAreaName = selectedAreaId?.let { areaNames[it]?.name },
    selectedProjectName = selectedProjectId?.let { projectNames[it]?.name },
)

private fun MailFacetItemDto.option(names: Map<String, MailNameAndColor>): MailFacetOption? {
    val known = names[id] ?: return null
    return known.name?.let { MailFacetOption(id, it, known.color, count, areaId) }
}
