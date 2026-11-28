package cz.alldots.app.data

import cz.alldots.app.core.FailureKind
import cz.alldots.app.domain.InboxCapture
import cz.alldots.app.domain.InboxCaptureFile
import cz.alldots.app.domain.InboxCaptureRepository
import cz.alldots.app.domain.InboxCaptureSource
import cz.alldots.app.domain.InboxType
import cz.alldots.app.domain.RepositoryResult
import cz.alldots.app.domain.map
import cz.alldots.app.domain.then
import io.ktor.http.HttpMethod
import kotlinx.serialization.Serializable

/** The route that uploads the file of a capture on its own; its answer names the blob the capture attaches. */
internal const val INBOX_BLOBS_PATH = "/api/blobs"

/** The route that creates an Inbox item, its type and its attachments in one transaction. */
internal const val INBOX_ITEMS_PATH = "/api/inbox/items"

/**
 * Captures into the Inbox through `POST /api/inbox/items`, which creates the item, its type and its attachments in one
 * transaction; a file is first uploaded on its own with `POST /api/blobs`, whose answer names the blob the capture
 * then attaches. With an offline layer the capture is added to its outbox ([CaptureOutbox]), which sends it in the
 * background: the capture succeeds once it is written on the device. Without one (no data directory) it is sent at
 * once, and a capture whose upload fails is not sent.
 */
class HttpInboxCaptureRepository(private val api: AuthenticatedApi) : InboxCaptureRepository {

    override suspend fun types(): RepositoryResult<List<InboxType>> =
        api.send(HttpMethod.Get, TYPES_PATH).decode<InboxTypesDto>().map { list ->
            list.types.map { InboxType(it.id, it.label, it.emoji, it.targetLabel) }
        }

    override suspend fun capture(capture: InboxCapture): RepositoryResult<Unit> {
        val outbox = api.offline?.captures
        val session = api.session()
        return when {
            outbox == null -> sendNow(capture)
            session == null -> RepositoryResult.Failure(FailureKind.UNAUTHORIZED)
            else -> outbox.add(session, capture)
        }
    }

    private suspend fun sendNow(capture: InboxCapture): RepositoryResult<Unit> {
        val file = capture.file ?: return send(capture, emptyList())
        return upload(file).then { blobId ->
            send(capture, listOf(InboxCaptureAttachmentDto(blobId, file.source.wire())))
        }
    }

    private suspend fun upload(file: InboxCaptureFile): RepositoryResult<String> =
        api.upload(INBOX_BLOBS_PATH, RawBody(file.mimeType, file.bytes), emptyList())
            .decode<InboxCaptureBlobDto>()
            .map { it.blobId }

    private suspend fun send(
        capture: InboxCapture,
        attachments: List<InboxCaptureAttachmentDto>,
    ): RepositoryResult<Unit> {
        val json = inboxCaptureBody(capture.text, capture.day.toString(), capture.time, capture.typeId, attachments)
        return api.send(HttpMethod.Post, INBOX_ITEMS_PATH, body = json).ignoreBody()
    }

    private companion object {
        const val TYPES_PATH = "/api/inbox-types"
    }
}

/** The body of `POST /api/inbox/items` for a typed capture of [text] on [date] (`YYYY-MM-DD`) at [time] (`HH:mm`). */
internal fun inboxCaptureBody(
    text: String,
    date: String,
    time: String,
    typeId: String?,
    attachments: List<InboxCaptureAttachmentDto>,
): String = ApiJson.encodeToString(
    InboxCaptureRequestDto.serializer(),
    InboxCaptureRequestDto(
        text = text,
        date = date,
        time = time,
        captureChannel = TYPED_CAPTURE_CHANNEL,
        typeId = typeId,
        attachments = attachments,
    ),
)

private const val TYPED_CAPTURE_CHANNEL = "typed"

/** The `source` of an attachment, as `POST /api/inbox/items` names it. */
internal fun InboxCaptureSource.wire(): String = when (this) {
    InboxCaptureSource.CAMERA -> "camera"
    InboxCaptureSource.PHOTO_LIBRARY -> "photoLibrary"
    InboxCaptureSource.FILES -> "files"
}

@Serializable
internal data class InboxCaptureRequestDto(
    val text: String,
    val date: String,
    val time: String,
    val captureChannel: String,
    val typeId: String? = null,
    val attachments: List<InboxCaptureAttachmentDto> = emptyList(),
)

@Serializable
internal data class InboxCaptureAttachmentDto(val blobId: String, val source: String)

/** The answer of `POST /api/blobs`. */
@Serializable
internal data class InboxCaptureBlobDto(val blobId: String)
