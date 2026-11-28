package cz.alldots.app.data

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

/**
 * Captures into the Inbox through `POST /api/inbox/items`, which creates the item, its type and its attachments in one
 * transaction. A file is first uploaded on its own with `POST /api/blobs`, whose answer names the blob the capture
 * then attaches; a capture whose upload fails is not sent.
 */
class HttpInboxCaptureRepository(private val api: AuthenticatedApi) : InboxCaptureRepository {

    override suspend fun types(): RepositoryResult<List<InboxType>> =
        api.send(HttpMethod.Get, TYPES_PATH).decode<InboxTypesDto>().map { list ->
            list.types.map { InboxType(it.id, it.label, it.emoji, it.targetLabel) }
        }

    override suspend fun capture(capture: InboxCapture): RepositoryResult<Unit> {
        val file = capture.file ?: return send(capture, emptyList())
        return upload(file).then { blobId ->
            send(capture, listOf(InboxCaptureAttachmentDto(blobId, file.source.wire())))
        }
    }

    private suspend fun upload(file: InboxCaptureFile): RepositoryResult<String> =
        api.upload(BLOBS_PATH, RawBody(file.mimeType, file.bytes), emptyList())
            .decode<InboxCaptureBlobDto>()
            .map { it.blobId }

    private suspend fun send(
        capture: InboxCapture,
        attachments: List<InboxCaptureAttachmentDto>,
    ): RepositoryResult<Unit> {
        val body = InboxCaptureRequestDto(
            text = capture.text,
            date = capture.day.toString(),
            time = capture.time,
            captureChannel = TYPED,
            typeId = capture.typeId,
            attachments = attachments,
        )
        val json = ApiJson.encodeToString(InboxCaptureRequestDto.serializer(), body)
        return api.send(HttpMethod.Post, ITEMS_PATH, body = json).ignoreBody()
    }

    private companion object {
        const val TYPES_PATH = "/api/inbox-types"
        const val ITEMS_PATH = "/api/inbox/items"
        const val BLOBS_PATH = "/api/blobs"
        const val TYPED = "typed"
    }
}

/** The `source` of an attachment, as `POST /api/inbox/items` names it. */
private fun InboxCaptureSource.wire(): String = when (this) {
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
