package cz.alldots.app.domain

/** Where the bytes of an attachment of an Inbox item are. */
sealed interface InboxAttachmentLocation {
    /** On the server, as the blob [blobId] (`GET /api/blobs/:id`). */
    data class Blob(val blobId: String) : InboxAttachmentLocation

    /** Only on the device: the file of the capture [captureId], which waits in the outbox for the server. */
    data class WaitingCapture(val captureId: String) : InboxAttachmentLocation
}

/**
 * A file attached to an Inbox item. [name] is its file name when the item has one (captured files usually have
 * none), [mimeType] its media type and [source] how it was captured (`camera`, `scan`, `photoLibrary`, `files`,
 * `share`), as the server names them.
 */
data class InboxAttachment(
    val id: String,
    val name: String?,
    val mimeType: String?,
    val source: String?,
    val location: InboxAttachmentLocation,
)

/** The files of attachments on the device. */
interface InboxAttachmentFiles {
    /**
     * The path of a local file named [fileName] that holds the bytes at [location]. A server attachment is
     * downloaded once and the file kept is answered afterwards; a waiting capture's bytes are copied from the outbox.
     */
    suspend fun file(location: InboxAttachmentLocation, fileName: String): RepositoryResult<String>
}

/** Answers a local file of [attachment] that a preview can open, named by [attachmentFileName]. */
class OpenInboxAttachment(private val files: InboxAttachmentFiles) {
    suspend operator fun invoke(attachment: InboxAttachment): RepositoryResult<String> =
        files.file(attachment.location, attachmentFileName(attachment.name, attachment.mimeType, attachment.source))
}

private const val MAX_FILE_NAME_LENGTH = 100
private const val MAX_EXTENSION_LENGTH = 10
// Control characters, bidirectional controls and what a path or a file system reserves.
private val UNSAFE_CHARACTERS =
    Regex("[\\u0000-\\u001f\\u007f\\u200e\\u200f\\u202a-\\u202e\\u2066-\\u2069/\\\\:*?\"<>|]")

/** The extensions of the media types attachments have, the one a file gets first. */
private val EXTENSIONS = mapOf(
    "application/pdf" to listOf("pdf"),
    "image/jpeg" to listOf("jpg", "jpeg"),
    "image/png" to listOf("png"),
    "image/heic" to listOf("heic"),
    "image/gif" to listOf("gif"),
    "image/webp" to listOf("webp"),
    "text/plain" to listOf("txt"),
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" to listOf("xlsx"),
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document" to listOf("docx"),
    "audio/mp4" to listOf("m4a", "mp4"),
    "audio/x-m4a" to listOf("m4a"),
    "audio/mpeg" to listOf("mp3"),
)

/**
 * A file name for an attachment that is safe to write in one directory: [name] without any path, control or
 * reserved characters, without leading dots and at most [MAX_FILE_NAME_LENGTH] characters long. Without a usable
 * name the file is named after its [source] (`Photo`, `Scan`, `Attachment`). The name ends in an extension of its
 * [mimeType]: one is added when it has none of that type's, so the system opens it as what it is.
 */
fun attachmentFileName(name: String?, mimeType: String?, source: String?): String {
    val lastPart = name.orEmpty().substringAfterLast('/').substringAfterLast('\\')
    val cleaned = lastPart.replace(UNSAFE_CHARACTERS, "").trimStart { it == '.' || it.isWhitespace() }.trimEnd()
    val base = cleaned.ifEmpty { fallbackName(source) }
    val extensions = mimeType?.substringBefore(';')?.trim()?.lowercase()?.let(EXTENSIONS::get).orEmpty()
    val present = base.substringAfterLast('.', "").lowercase()
    val named = if (extensions.isEmpty() || present in extensions) base else "$base.${extensions.first()}"
    return named.shortened()
}

private fun fallbackName(source: String?): String = when (source) {
    "camera", "photoLibrary" -> "Photo"
    "scan" -> "Scan"
    else -> "Attachment"
}

/** [this] cut to [MAX_FILE_NAME_LENGTH] characters, keeping a short extension. */
private fun String.shortened(): String {
    if (length <= MAX_FILE_NAME_LENGTH) return this
    val extension = substringAfterLast('.', "").takeIf { it.isNotEmpty() && it.length <= MAX_EXTENSION_LENGTH }
    return if (extension == null) {
        take(MAX_FILE_NAME_LENGTH).trimEnd()
    } else {
        substringBeforeLast('.').take(MAX_FILE_NAME_LENGTH - extension.length - 1).trimEnd() + ".$extension"
    }
}
