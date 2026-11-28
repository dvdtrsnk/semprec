package cz.alldots.app.presentation

/** What the person does in the Inbox. A field action names its card and its field by their ids. */
sealed interface InboxAction {
    /** Loads the stack again after a failure, showing the wait. */
    data object Retry : InboxAction

    /** Reads the stack again in place (pull to refresh); the cards stay on screen. */
    data object Refresh : InboxAction

    data class SetText(val cardId: String, val key: String, val text: String) : InboxAction
    data class SetFlag(val cardId: String, val key: String, val on: Boolean) : InboxAction
    data class SetDate(val cardId: String, val key: String, val date: String) : InboxAction
    data class SetTime(val cardId: String, val key: String, val time: String) : InboxAction

    /** Picks one choice of a select, a segmented control, a colour row or a list of choices; `null` is none. */
    data class Pick(val cardId: String, val key: String, val choiceId: String?) : InboxAction

    /** Adds the choice to, or removes it from, the selection of a multi-value field. */
    data class Toggle(val cardId: String, val key: String, val choiceId: String) : InboxAction

    /** Opens the picker of a field over its card; items are asked for when the field has not got them yet. */
    data class OpenPicker(val cardId: String, val key: String) : InboxAction

    data object ClosePicker : InboxAction

    /** The secret typed for the card (the key of an MCP server); it is sent with the approval and nowhere else. */
    data class SetSecret(val cardId: String, val text: String) : InboxAction

    /** Approves the top card: confirms its proposal, approves a request of Semp, or prepares a clarified capture. */
    data object Approve : InboxAction

    /** Discards the top card without writing anything. */
    data object Reject : InboxAction

    /** Returns the last decided card to the stack. */
    data object Undo : InboxAction

    /** Returns the card to the last proposal of Semp. */
    data class Reset(val cardId: String) : InboxAction

    /** Asks Semp to compute the card again. */
    data class Recompute(val cardId: String) : InboxAction

    /** Opens the item the last decision created. */
    data object OpenResult : InboxAction

    data object DismissResult : InboxAction
    data object DismissProblem : InboxAction

    /** Makes the attachment [attachmentId] of the card's source ready to preview, in [InboxState.attachment]. */
    data class OpenAttachment(val cardId: String, val attachmentId: String) : InboxAction

    /** Ends the preview of an attachment, or its failure, and stops one being opened. */
    data object CloseAttachment : InboxAction
}
