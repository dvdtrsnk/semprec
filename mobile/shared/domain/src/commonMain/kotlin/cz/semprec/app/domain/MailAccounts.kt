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
