package cz.alldots.app.domain

/** Where an attached file of a capture came from, as the server records it. */
enum class InboxCaptureSource { CAMERA, PHOTO_LIBRARY, FILES }

/** A file attached to a capture: its name, its media type and its bytes. */
class InboxCaptureFile(
    val filename: String,
    val mimeType: String,
    val bytes: ByteArray,
    val source: InboxCaptureSource,
)

/**
 * Something the person writes down to sort out later: [text] (blank only with a [file]), captured on [day] at [time]
 * (`HH:mm`, the person's wall clock), with the Inbox item type [typeId] when they picked one.
 */
class InboxCapture(
    val text: String,
    val day: CalendarDay,
    val time: String,
    val typeId: String?,
    val file: InboxCaptureFile?,
)

/** Typed captures into the Inbox and the item types they can have. */
interface InboxCaptureRepository {
    /** The active Inbox item types, in the order the server lists them. */
    suspend fun types(): RepositoryResult<List<InboxType>>

    /**
     * Captures [capture] into the Inbox: its file, if any, is uploaded and the item is created with it in one request.
     * A device that keeps data succeeds once the capture is kept on it and sends it in the background.
     */
    suspend fun capture(capture: InboxCapture): RepositoryResult<Unit>
}
