package cz.semprec.app.data

import cz.semprec.app.core.FailureKind
import cz.semprec.app.domain.JournalPeriod
import cz.semprec.app.domain.JournalPeriodPage
import cz.semprec.app.domain.JournalRepository
import cz.semprec.app.domain.PageDocument
import cz.semprec.app.domain.PageWrite
import cz.semprec.app.domain.RepositoryResult
import io.ktor.http.ContentType
import io.ktor.http.HttpMethod

private const val CONFLICT_STATUS = 409
private const val PRECONDITION_FAILED_STATUS = 412
private val MARKDOWN = ContentType.parse("text/markdown; charset=utf-8")

/** The Journal over the journal period routes and the page Markdown routes of an item (`page.md`). */
class HttpJournalRepository(private val api: AuthenticatedApi) : JournalRepository {
    override suspend fun period(period: JournalPeriod): RepositoryResult<JournalPeriodPage> =
        when (val read = api.send(HttpMethod.Get, periodPath(period)).decode<JournalPeriodResponse>()) {
            is RepositoryResult.Failure -> read
            is RepositoryResult.Content -> read.value.toDomain(period)
                ?.let { RepositoryResult.Content(it) }
                ?: RepositoryResult.Failure(FailureKind.INVALID_DATA)
        }

    override suspend fun ensurePage(period: JournalPeriod): RepositoryResult<String> =
        when (val ensured = api.send(HttpMethod.Put, "${periodPath(period)}/doc").decode<JournalEnsureResponse>()) {
            is RepositoryResult.Failure -> ensured
            is RepositoryResult.Content -> RepositoryResult.Content(ensured.value.itemId)
        }

    override suspend fun page(itemId: String): RepositoryResult<PageDocument> =
        when (val response = api.send(HttpMethod.Get, pagePath(itemId))) {
            is ApiResponse.Failure -> RepositoryResult.Failure(response.kind)
            is ApiResponse.Success -> {
                val etag = response.etag
                if (etag == null) {
                    RepositoryResult.Failure(FailureKind.INVALID_DATA)
                } else {
                    RepositoryResult.Content(PageDocument(response.body, etag))
                }
            }
        }

    override suspend fun replacePage(itemId: String, markdown: String, etag: String): RepositoryResult<PageWrite> =
        when (
            val response = api.send(
                HttpMethod.Put,
                pagePath(itemId),
                body = markdown,
                extraHeaders = listOf("If-Match" to etag),
                bodyContentType = MARKDOWN,
            )
        ) {
            is ApiResponse.Success -> RepositoryResult.Content(PageWrite.Saved(response.etag ?: etag))
            is ApiResponse.Failure ->
                if (response.status == CONFLICT_STATUS || response.status == PRECONDITION_FAILED_STATUS) {
                    RepositoryResult.Content(PageWrite.Conflict)
                } else {
                    RepositoryResult.Failure(response.kind)
                }
        }

    private fun periodPath(period: JournalPeriod): String = "/api/journal/periods/${period.type.wireName}/${period.key}"

    private fun pagePath(itemId: String): String = "/api/items/$itemId/page.md"
}
