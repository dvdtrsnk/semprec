package cz.semprec.app.presentation

import cz.semprec.app.core.FailureKind

enum class MailAccountsPhase { LOADING, CONTENT, ERROR }

/** A row of the accounts list; [provider] is the stored key (`gmail`, `outlook`, `icloud`, `imap`), `null` if unknown. */
data class MailAccountItem(
    val id: String,
    val name: String,
    val address: String?,
    val provider: String?,
    val status: MailAccountStatus,
)

/** The mailboxes that are connected with an address and a password; Gmail and Outlook sign in in a browser. */
enum class MailConnectKind { ICLOUD, GENERIC }

/** Why a mailbox was not connected: the input is incomplete, the server refused it, or it could not be reached. */
enum class MailConnectFailure { INVALID_INPUT, REFUSED, UNAVAILABLE, UNEXPECTED }

data class MailAccountsState(
    val phase: MailAccountsPhase = MailAccountsPhase.LOADING,
    val failure: FailureKind? = null,
    val refreshing: Boolean = false,
    val accounts: List<MailAccountItem> = emptyList(),
    val connecting: Boolean = false,
    val connectFailure: MailConnectFailure? = null,
)

sealed interface MailAccountsAction {
    data object Retry : MailAccountsAction
    data object Refresh : MailAccountsAction
    data class Open(val mailboxId: String) : MailAccountsAction

    /** Connects a mailbox with its address and password; the servers are for [MailConnectKind.GENERIC] only. */
    data class Connect(
        val kind: MailConnectKind,
        val address: String,
        val password: String,
        val imapHost: String,
        val smtpHost: String,
    ) : MailAccountsAction
    data object DismissConnectFailure : MailAccountsAction
}

sealed interface MailAccountsEffect {
    data class OpenAccount(val mailboxId: String) : MailAccountsEffect

    /** A mailbox was connected and the list shows it; the form closes. */
    data object Connected : MailAccountsEffect
}
