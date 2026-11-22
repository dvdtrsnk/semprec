package cz.semprec.app.domain

/** What the server last knew about a mailbox's sync. */
enum class MailSyncStatus { OK, ERROR, NEVER, NEEDS_REAUTHORIZATION }

data class MailAccount(
    val id: String,
    val name: String,
    val provider: String?,
    val primaryAddress: String?,
    val syncMode: String,
    val syncStatus: MailSyncStatus,
    val initialSyncInProgress: Boolean,
    val lastSuccessfulSyncAt: String?,
    val failingSince: String?,
    val connectionLimit: Int,
    val connectionLimitApplies: Boolean,
    val autonomousSendProjectCount: Int,
    /** The messages downloaded so far while the first sync runs; `null` once it is done or when unknown. */
    val syncedMessageCount: Int? = null,
)

/** A folder or label of a mailbox with its unread thread count and its message count. */
data class MailFolder(
    val id: String,
    val name: String,
    val specialPurpose: String,
    val unreadCount: Int,
    val totalCount: Int,
)

/** What removing a mailbox hides: its messages, drafts, threads that only it holds, and the attachments kept. */
data class MailRemovalImpact(val messages: Int, val drafts: Int, val threads: Int, val attachmentsKept: Int)

enum class MailPasswordProvider { ICLOUD, GENERIC }

/**
 * The login of an iCloud or generic IMAP mailbox; the servers are for [MailPasswordProvider.GENERIC] only.
 * [caldavUrl] is the CalDAV server of a generic account, `null` when the person left it empty.
 */
data class MailPasswordAccount(
    val provider: MailPasswordProvider,
    val address: String,
    val password: String,
    val imapHost: String?,
    val smtpHost: String?,
    val caldavUrl: String? = null,
)

/**
 * Why the server refused a password login it checked: the user name or password, an iCloud account that needs an
 * app-specific password, a mail server that could not be reached or whose TLS failed, a CalDAV server that refused
 * the login or could not be found, an address that another mailbox already holds, or too many attempts.
 */
enum class MailConnectRefusal {
    WRONG_CREDENTIALS,
    APP_PASSWORD_REQUIRED,
    SERVER_UNREACHABLE,
    TLS_FAILED,
    CALDAV_REFUSED,
    CALDAV_UNREACHABLE,
    ALREADY_CONNECTED,
    RATE_LIMITED,
}

/**
 * How a checked password login ended: the mailbox [Connected.mailboxId] is connected (new or signed in again), or the
 * login was [Refused].
 */
sealed interface MailConnectOutcome {
    data class Connected(val mailboxId: String) : MailConnectOutcome

    data class Refused(val reason: MailConnectRefusal) : MailConnectOutcome
}
