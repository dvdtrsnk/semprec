package cz.alldots.app.data

import cz.alldots.app.core.FailureKind
import cz.alldots.app.core.StoredSession
import cz.alldots.app.domain.InboxAttachmentFiles
import cz.alldots.app.domain.InboxAttachmentLocation
import cz.alldots.app.domain.RepositoryResult
import cz.alldots.app.domain.attachmentFileName
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/** The largest attachment downloaded; a longer answer is refused rather than held in memory. */
internal const val ATTACHMENT_MAX_BYTES = 100L * 1024 * 1024

// A large scan over a slow connection takes far longer than a JSON call.
private const val ATTACHMENT_DOWNLOAD_TIMEOUT_MILLIS = 600_000L
private const val ROOT = "inbox-attachments"
private val SAFE_ID = Regex("^[A-Za-z0-9-]{1,64}$")

/**
 * The files of Inbox attachments under `directory/inbox-attachments/<account>/`, where `<account>` names the server
 * and the session ([accountKey]). A server attachment is downloaded with `GET /api/blobs/:id` into `blobs/<blobId>/`
 * and that file is answered from then on, also without a connection; one never downloaded fails offline with
 * [FailureKind.UNAVAILABLE]. The file of a capture that waits in the outbox is copied from it into
 * `captures/<captureId>/` on every call, since the capture may have been sent and deleted since. A blob or capture id
 * that is not a plain id, and a file name that [attachmentFileName] would change (a path, `.` or `..`, an empty name,
 * control or reserved characters), are [FailureKind.INVALID_DATA] and never become part of a path. Without a
 * [directory] there is nowhere to keep a file, and every call fails with [FailureKind.UNAVAILABLE].
 */
class FileInboxAttachmentFiles internal constructor(
    private val directory: String?,
    private val api: AuthenticatedApi,
    private val dispatcher: CoroutineDispatcher,
) : InboxAttachmentFiles {
    constructor(directory: String?, api: AuthenticatedApi) : this(directory, api, Dispatchers.Default)

    override suspend fun file(location: InboxAttachmentLocation, fileName: String): RepositoryResult<String> {
        val session = api.session()
        val id = when (location) {
            is InboxAttachmentLocation.Blob -> location.blobId
            is InboxAttachmentLocation.WaitingCapture -> location.captureId
        }
        return when {
            directory == null -> RepositoryResult.Failure(FailureKind.UNAVAILABLE)
            session == null -> RepositoryResult.Failure(FailureKind.UNAUTHORIZED)
            !SAFE_ID.matches(id) || !isSafeFileName(fileName) -> RepositoryResult.Failure(FailureKind.INVALID_DATA)
            else -> {
                val account = "${root(directory)}/${accountKey(session)}"
                when (location) {
                    is InboxAttachmentLocation.Blob -> blob(location.blobId, "$account/blobs/$id", fileName)
                    is InboxAttachmentLocation.WaitingCapture ->
                        waiting(session, location.captureId, "$account/captures/$id/$fileName")
                }
            }
        }
    }

    /** Deletes every attachment file kept, of every account. */
    suspend fun clear() {
        if (directory != null) io { deleteCachePath(root(directory)) }
    }

    private suspend fun blob(blobId: String, folder: String, fileName: String): RepositoryResult<String> {
        val path = "$folder/$fileName"
        if (io { fileName in listCacheDirectory(folder) }) return RepositoryResult.Content(path)
        val route = "/api/blobs/$blobId"
        return when (val response = api.download(route, ATTACHMENT_MAX_BYTES, ATTACHMENT_DOWNLOAD_TIMEOUT_MILLIS)) {
            is ApiBytesResponse.Failure -> RepositoryResult.Failure(response.kind)
            is ApiBytesResponse.Success -> written(path, response.bytes)
        }
    }

    private suspend fun waiting(session: StoredSession, captureId: String, path: String): RepositoryResult<String> {
        val outbox = api.offline?.captures
        val owner = outbox?.ownerOf(session)
        val bytes = owner?.let { outbox.files.bytes(it, captureId) }
        return if (bytes == null) RepositoryResult.Failure(FailureKind.NOT_FOUND) else written(path, bytes)
    }

    private suspend fun written(path: String, bytes: ByteArray): RepositoryResult<String> =
        if (io { writeCacheBytes(path, bytes) }) {
            RepositoryResult.Content(path)
        } else {
            RepositoryResult.Failure(FailureKind.UNAVAILABLE)
        }

    private suspend fun <T> io(block: () -> T): T = withContext(dispatcher) { block() }

    private fun root(directory: String) = "${directory.trimEnd('/')}/$ROOT"
}

/** A single file name the domain sanitizer leaves as it is, so it names a file in one directory and nothing else. */
private fun isSafeFileName(fileName: String): Boolean = attachmentFileName(fileName, null, null) == fileName
