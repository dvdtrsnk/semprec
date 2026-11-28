package cz.alldots.app.presentation

/** An Inbox item type a capture can have. */
data class InboxCaptureTypeState(val id: String, val label: String, val emoji: String)

/** The file attached to the capture being written: its name, its media type and how many bytes it has. */
data class InboxCaptureAttachmentState(val filename: String, val mimeType: String, val byteSize: Int)

/** Where an attached file came from. */
enum class InboxCaptureAttachmentSource { CAMERA, PHOTO_LIBRARY, FILES }

enum class InboxCapturePhase { IDLE, LOADING, READY, FAILED }

/**
 * The capture row of the diary's Inbox. [types] load when the type picker first opens ([typesPhase]); [typeId] is the
 * picked type, `null` for none. The text is the host's until it is sent. [sending] is `true` while the capture is
 * written; [failure] says why the last one was not.
 */
data class InboxCaptureState(
    val types: List<InboxCaptureTypeState> = emptyList(),
    val typesPhase: InboxCapturePhase = InboxCapturePhase.IDLE,
    val typeId: String? = null,
    val attachment: InboxCaptureAttachmentState? = null,
    val sending: Boolean = false,
    val failure: Failed? = null,
)

sealed interface InboxCaptureAction {
    /** Loads the item types, unless they are loaded or loading. */
    data object LoadTypes : InboxCaptureAction

    /** Picks the type of the capture; `null` for none. A type that is not one of [InboxCaptureState.types] is ignored. */
    data class PickType(val typeId: String?) : InboxCaptureAction

    /** Attaches a file, given as Base64 text of its bytes; it replaces the one attached before. */
    data class Attach(
        val filename: String,
        val mimeType: String,
        val base64: String,
        val source: InboxCaptureAttachmentSource,
    ) : InboxCaptureAction

    data object RemoveAttachment : InboxCaptureAction

    /** Sends the capture: [text], captured on [day] (`YYYY-MM-DD`) at [time] (`HH:mm`). */
    data class Submit(val text: String, val day: String, val time: String) : InboxCaptureAction

    data object DismissFailure : InboxCaptureAction
}

sealed interface InboxCaptureEffect {
    /** The capture is in the Inbox: the host clears its text and shows the day again. */
    data object Captured : InboxCaptureEffect
}
