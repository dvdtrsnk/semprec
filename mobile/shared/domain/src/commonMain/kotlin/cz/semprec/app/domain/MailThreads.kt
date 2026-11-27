package cz.semprec.app.domain

/** A name and an address as the mail API lists them; [name] is empty when the address has no display name. */
data class MailAddress(val name: String, val address: String)

/** A project, a company or a mailbox that a mail value points at. */
data class MailNamedRef(val id: String, val name: String)

/** The boxes the thread list offers; `INBOX` is the default list without drafts and junk. */
enum class MailBox { INBOX, FLAGGED, SEMP_DRAFTS }

/** What the thread list is asked for; [cursor] continues a list after the last thread of the page before. */
data class MailThreadQuery(
    val box: MailBox = MailBox.INBOX,
    val mailboxId: String? = null,
    val folderId: String? = null,
    val projectId: String? = null,
    val unreadOnly: Boolean = false,
    val search: String = "",
    val cursor: String? = null,
)

/** Who ended a value link that a value had taken over from its source. */
enum class MailLinkBreaker { USER, AGENT }

/** How a value of a thread, a file or a task is tied to its source: taken over, taken over and since changed, derived. */
enum class MailLinkKind { INHERITED, BROKEN, DERIVED }

/** A value link with the titles of the items it follows; [brokenBy] is set only for [MailLinkKind.BROKEN]. */
data class MailLink(val kind: MailLinkKind, val sourceTitles: List<String>, val brokenBy: MailLinkBreaker?)

/** One thread of the list, aggregated over its messages by the server. */
data class MailThreadSummary(
    val threadId: String,
    val subject: String,
    val lastMessageAt: String,
    val senderName: String,
    val senderAddress: String,
    val senderRelationship: String?,
    val messageCount: Int,
    val preview: String?,
    val hasAttachment: Boolean,
    val unread: Boolean,
    val flagged: Boolean,
    val mailboxNames: List<String>,
    val project: MailNamedRef?,
    val company: MailNamedRef?,
    val hasSempDraft: Boolean,
)

/**
 * One page of a thread list, newest first. [changesCursor] names the server's state the page was read in; the changes
 * of the view since then are asked for with it ([MailRepository.threadChanges]). A search answers none.
 */
data class MailThreadPage(
    val threads: List<MailThreadSummary>,
    val nextCursor: String?,
    val changesCursor: String? = null,
)

/**
 * What changed in one list view since a changes cursor: [threads] are the changed rows that are in the view, [removed]
 * the ids of changed threads that are not (any more), and [cursor] asks for the changes after these. [reset] says the
 * server cannot tell the changes since that cursor; the view is then read again from its first page.
 */
data class MailThreadChanges(
    val cursor: String,
    val threads: List<MailThreadSummary>,
    val removed: List<String>,
    val reset: Boolean,
)

/** A project of the filter with the number of threads it holds. */
data class MailFacetOption(val id: String, val name: String, val color: String?, val count: Int)

/** The thread counts of the filter: [total] over everything, one option per project. */
data class MailFacets(
    val total: Int,
    val projectsTotal: Int,
    val projects: List<MailFacetOption>,
    val selectedProjectName: String?,
)

/** The counts of the mail smart boxes and the mailboxes that cannot sync until the person signs in again. */
data class MailSummary(
    val unreadInbox: Int,
    val flagged: Int,
    val sempDrafts: Int,
    val accounts: Int,
    val needingReauthorization: List<MailNamedRef>,
)

/**
 * A file of a message. [stored] says the server holds its bytes ([blobId]); an attachment of a message the server only
 * indexed has none until it is saved. [fileItemId] is the Files item the attachment is saved as, if any.
 */
data class MailAttachment(
    val attachmentId: String,
    val filename: String,
    val contentType: String,
    val byteSize: Long,
    val stored: Boolean,
    val blobId: String?,
    val fileItemId: String?,
    val project: MailNamedRef?,
    val projectLink: MailLink?,
)

/**
 * Where a message's body is: stored with the message ([FULL]), a copy the server fetched from the provider and still
 * keeps ([CACHED]), or only at the provider ([REMOTE]), where the server fetches it when asked.
 */
enum class MailContentState { FULL, CACHED, REMOTE }

data class MailMessage(
    val emailId: String,
    val mailboxId: String?,
    val folderPurpose: String?,
    val own: Boolean,
    val from: MailAddress?,
    val to: List<MailAddress>,
    val cc: List<MailAddress>,
    val date: String?,
    /** Empty while [contentState] is [MailContentState.REMOTE]. */
    val bodyText: String,
    val contentState: MailContentState,
    /** The short snippet the server keeps for every message. */
    val preview: String?,
    val read: Boolean,
    val attachments: List<MailAttachment>,
)

/** The body of one message as `messageContent` answers it, fetched from the provider when the server had none. */
data class MailMessageContent(val emailId: String, val bodyText: String)

/** A task made from a thread; [status] is the stored key (`notDone`, `done`). */
data class MailThreadTask(
    val id: String,
    val name: String,
    val date: String?,
    val status: String,
    val projectName: String?,
    val projectLink: MailLink?,
    val peopleNames: List<String>,
    val peopleLink: MailLink?,
)

data class MailThreadDetail(
    val threadId: String,
    val subject: String,
    val messageCount: Int,
    val unread: Boolean,
    val flagged: Boolean,
    val mailboxNames: List<String>,
    val senderName: String,
    val senderAddress: String,
    val senderRelationship: String?,
    val project: MailNamedRef?,
    val company: MailNamedRef?,
    val projectLink: MailLink?,
    val companyLink: MailLink?,
    val messages: List<MailMessage>,
    val tasks: List<MailThreadTask>,
)

/**
 * What a search found: the threads of the local index, and what the provider search of each mailbox added.
 * [MailRemoteSearch.searched] are the mailboxes whose provider was asked, [MailRemoteSearch.failed] those whose
 * provider search failed, and [MailRemoteSearch.unindexed] counts the provider hits the local index does not hold yet.
 */
data class MailSearchResult(val threads: List<MailThreadSummary>, val remote: MailRemoteSearch)

data class MailRemoteSearch(val searched: List<String>, val failed: List<String>, val unindexed: Int)

/** A person suggested as a recipient. */
data class MailContact(val name: String, val address: String, val relationship: String?)
