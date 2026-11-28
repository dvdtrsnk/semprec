package cz.alldots.app.data

import cz.alldots.app.core.FailureKind
import cz.alldots.app.domain.MailHistoryClaim
import cz.alldots.app.domain.MailHistoryFolder
import cz.alldots.app.domain.MailHistoryRepository
import cz.alldots.app.domain.MailHistorySlice
import cz.alldots.app.domain.MailHistoryUploadOutcome
import cz.alldots.app.domain.RepositoryResult
import cz.alldots.app.domain.map
import cz.alldots.app.domain.then
import io.ktor.http.HttpMethod
import io.ktor.http.encodeURLPathPart
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import kotlinx.serialization.SerializationException
import kotlinx.serialization.json.add
import kotlinx.serialization.json.addJsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray
import kotlin.io.encoding.Base64

private const val MAX_IMAP_NUMBER = 4_294_967_295L

/** An upload carries up to 8 MiB that the server parses and writes in transactions of 50 messages. */
private const val UPLOAD_TIMEOUT_MILLIS = 120_000L

/**
 * The history upload of `/api/mail/mailboxes/:id/history-index*`: the claim of a lease, one slice of a folder's
 * history with each FETCH response base64-encoded, and the release. An upload the server refuses because the
 * folder's state moved on is a [MailHistoryUploadOutcome]; any other failure stays its [FailureKind].
 */
class HttpMailHistoryRepository(private val api: AuthenticatedApi) : MailHistoryRepository {
    override suspend fun claim(mailboxId: String, leaseToken: String?): RepositoryResult<MailHistoryClaim> {
        val body = buildJsonObject { leaseToken?.let { put("leaseToken", it) } }
        return api.send(HttpMethod.Post, "${historyPath(mailboxId)}/claim", body = body.toString())
            .decode<MailHistoryClaimDto>()
            .then { it.toDomain() }
    }

    override suspend fun upload(
        mailboxId: String,
        slice: MailHistorySlice,
    ): RepositoryResult<MailHistoryUploadOutcome> {
        val body = withContext(Dispatchers.Default) { uploadBody(slice) }
        return api.send(
            HttpMethod.Post,
            historyPath(mailboxId),
            body = body,
            requestTimeoutMillis = UPLOAD_TIMEOUT_MILLIS,
        ).uploadOutcome()
    }

    override suspend fun release(mailboxId: String, leaseToken: String): RepositoryResult<Unit> {
        val body = buildJsonObject { put("leaseToken", leaseToken) }
        return api.send(HttpMethod.Post, "${historyPath(mailboxId)}/release", body = body.toString()).ignoreBody()
    }
}

private fun historyPath(mailboxId: String) = "/api/mail/mailboxes/${mailboxId.encodeURLPathPart()}/history-index"

private fun uploadBody(slice: MailHistorySlice): String = buildJsonObject {
    put("leaseToken", slice.leaseToken)
    put("folderId", slice.folderId)
    put("uidvalidity", slice.uidvalidity)
    put("rangeHigh", slice.rangeHigh)
    put("rangeLow", slice.rangeLow)
    putJsonArray("uids") { slice.messages.forEach { add(it.uid) } }
    putJsonArray("messages") {
        slice.messages.forEach { message ->
            addJsonObject {
                put("uid", message.uid)
                put("fetch", Base64.Default.encode(message.fetch))
            }
        }
    }
}.toString()

/** The refusals of an upload whose folder state moved on, by the code the server names them with. */
private fun ApiResponse.uploadOutcome(): RepositoryResult<MailHistoryUploadOutcome> = when (this) {
    is ApiResponse.Success -> decode<MailHistoryUploadDto>().then { answer ->
        if (answer.backfillBelowUid.isImapNumberOrNull()) {
            RepositoryResult.Content(MailHistoryUploadOutcome.Accepted(answer.backfillBelowUid))
        } else {
            RepositoryResult.Failure(FailureKind.INVALID_DATA)
        }
    }
    is ApiResponse.Failure -> when (errorCode()) {
        "mail_history_range_stale" -> staleCursor().map { MailHistoryUploadOutcome.RangeStale(it) }
        "mail_history_uidvalidity_changed" -> RepositoryResult.Content(MailHistoryUploadOutcome.UidvalidityChanged)
        "mail_history_lease_expired" -> RepositoryResult.Content(MailHistoryUploadOutcome.LeaseExpired)
        "mail_history_unavailable" -> RepositoryResult.Content(MailHistoryUploadOutcome.Unavailable)
        else -> RepositoryResult.Failure(kind)
    }
}

/** `details.backfillBelowUid` of a `mail_history_range_stale` refusal: the folder's cursor, `null` once complete. */
private fun ApiResponse.Failure.staleCursor(): RepositoryResult<Long?> {
    val details = try {
        ApiJson.decodeFromString(MailHistoryRefusalDto.serializer(), body.orEmpty()).error?.details
    } catch (_: SerializationException) {
        null
    } catch (_: IllegalArgumentException) {
        null
    }
    val cursor = details?.backfillBelowUid
    return if (details != null && cursor.isImapNumberOrNull()) {
        RepositoryResult.Content(cursor)
    } else {
        RepositoryResult.Failure(FailureKind.INVALID_DATA)
    }
}

private fun Long?.isImapNumberOrNull() = this == null || this in 1..MAX_IMAP_NUMBER

private fun MailHistoryClaimDto.toDomain(): RepositoryResult<MailHistoryClaim> {
    val valid = leaseToken.isNotEmpty() &&
        folders.all { it.uidvalidity in 1..MAX_IMAP_NUMBER && it.backfillBelowUid in 1..MAX_IMAP_NUMBER }
    return if (valid) {
        RepositoryResult.Content(
            MailHistoryClaim(
                leaseToken = leaseToken,
                folders = folders.map { MailHistoryFolder(it.folderId, it.path, it.uidvalidity, it.backfillBelowUid) },
                pendingFullBackfill = pendingFullBackfill,
            ),
        )
    } else {
        RepositoryResult.Failure(FailureKind.INVALID_DATA)
    }
}

@Serializable
private data class MailHistoryClaimDto(
    val leaseToken: String,
    val folders: List<MailHistoryFolderDto>,
    val pendingFullBackfill: Boolean,
)

@Serializable
private data class MailHistoryFolderDto(
    val folderId: String,
    val path: String,
    val uidvalidity: Long,
    val backfillBelowUid: Long,
)

@Serializable
private data class MailHistoryUploadDto(val accepted: Int, val backfillBelowUid: Long? = null)

@Serializable
private data class MailHistoryRefusalDto(val error: MailHistoryRefusalErrorDto? = null)

@Serializable
private data class MailHistoryRefusalErrorDto(val details: MailHistoryStaleDetailsDto? = null)

@Serializable
private data class MailHistoryStaleDetailsDto(val backfillBelowUid: Long? = null)
