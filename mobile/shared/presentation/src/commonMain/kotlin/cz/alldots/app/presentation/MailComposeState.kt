package cz.alldots.app.presentation

import cz.alldots.app.core.FailureKind
import cz.alldots.app.core.MailRefusal

enum class MailComposePhase { LOADING, EDITING, ERROR }

data class MailRecipient(val name: String, val address: String)

/** A mailbox the message can be sent from, with the address it is sent as. */
data class MailSender(val mailboxId: String, val name: String, val address: String)

data class MailSuggestion(val name: String, val address: String, val relationship: String?)

/**
 * A message being written. The subject and the text belong to the screen's fields: [initialSubject] and [initialBody]
 * seed them once when the draft is ready (a reply starts with the quote the server wrote), and the fields come back with
 * [MailComposeAction.Send]. [invalidAddress] says the last typed recipient was no address; [discardFailed] says leaving
 * could not remove the draft that was made for this message, so that leaving again keeps it. [refusal] and
 * [sendRefusal] name the reason the server gave for refusing the reply's draft or the send, next to [failure] and
 * [sendFailure].
 */
data class MailComposeState(
    val phase: MailComposePhase = MailComposePhase.LOADING,
    val failure: FailureKind? = null,
    val refusal: MailRefusal? = null,
    val senders: List<MailSender> = emptyList(),
    val senderId: String? = null,
    val to: List<MailRecipient> = emptyList(),
    val cc: List<MailRecipient> = emptyList(),
    val initialSubject: String = "",
    val initialBody: String = "",
    val suggestions: List<MailSuggestion> = emptyList(),
    val invalidAddress: Boolean = false,
    val sendPhase: MailSendPhase = MailSendPhase.IDLE,
    val sendFailure: FailureKind? = null,
    val sendRefusal: MailRefusal? = null,
    val sentFrom: String? = null,
    val discardFailed: Boolean = false,
)

sealed interface MailComposeAction {
    data object Retry : MailComposeAction

    /** Looks for people whose name or address contains [text]; blank text clears the suggestions. */
    data class SearchContacts(val text: String) : MailComposeAction
    data class AddRecipient(val name: String, val address: String) : MailComposeAction

    /** A typed address; text that is no address raises [MailComposeState.invalidAddress]. */
    data class AddAddress(val text: String) : MailComposeAction
    data class RemoveRecipient(val address: String) : MailComposeAction
    data class SelectSender(val mailboxId: String) : MailComposeAction
    data class Send(val subject: String, val body: String) : MailComposeAction

    /** Leaves; a draft that was made only for this message is discarded first. */
    data object Cancel : MailComposeAction
}

sealed interface MailComposeEffect {
    data object Close : MailComposeEffect
}
