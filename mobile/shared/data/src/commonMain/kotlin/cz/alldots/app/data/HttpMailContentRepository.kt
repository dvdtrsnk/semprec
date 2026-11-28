package cz.alldots.app.data

import cz.alldots.app.domain.MailContentOutcome
import cz.alldots.app.domain.MailContentRepository
import cz.alldots.app.domain.MailMessageContent
import cz.alldots.app.domain.MailSearchResult
import cz.alldots.app.domain.RepositoryResult
import cz.alldots.app.domain.map
import io.ktor.http.HttpMethod
import io.ktor.http.encodeURLPathPart

private const val SEARCH_LIMIT = "50"

/** The bound of a request the server answers only after it asked the mail provider. */
private const val PROVIDER_TIMEOUT_MILLIS = 120_000L

/**
 * The mail routes that may ask the mail provider: `GET /api/mail/messages/:emailId/content`,
 * `POST /api/mail/messages/:emailId/attachments/:attachmentId/save` and `GET /api/mail/search`. A `409
 * mail_content_unavailable` and a `429` of the first two are [MailContentOutcome.Unavailable].
 */
class HttpMailContentRepository(private val api: AuthenticatedApi) : MailContentRepository {
    override suspend fun messageContent(
        emailId: String,
    ): RepositoryResult<MailContentOutcome<MailMessageContent>> =
        api.send(HttpMethod.Get, "${messagePath(emailId)}/content", requestTimeoutMillis = PROVIDER_TIMEOUT_MILLIS)
            .mailContentOutcome { decode<MailMessageContentDto>().map { MailMessageContent(it.emailId, it.bodyText) } }

    override suspend fun saveAttachment(
        emailId: String,
        attachmentId: String,
    ): RepositoryResult<MailContentOutcome<String>> =
        api.send(
            HttpMethod.Post,
            "${messagePath(emailId)}/attachments/${attachmentId.encodeURLPathPart()}/save",
            body = "{}",
            requestTimeoutMillis = PROVIDER_TIMEOUT_MILLIS,
        ).mailContentOutcome { decode<MailAttachmentSavedDto>().map { it.fileItemId } }

    override suspend fun search(query: String, mailboxId: String?): RepositoryResult<MailSearchResult> {
        val parameters =
            listOfNotNull("q" to query.trim(), mailboxId?.let { "mailboxId" to it }, "limit" to SEARCH_LIMIT)
        return api.send(HttpMethod.Get, "/api/mail/search", parameters, requestTimeoutMillis = PROVIDER_TIMEOUT_MILLIS)
            .decode<MailSearchDto>().map { it.toDomain() }
    }
}

private fun messagePath(emailId: String) = "/api/mail/messages/${emailId.encodeURLPathPart()}"
