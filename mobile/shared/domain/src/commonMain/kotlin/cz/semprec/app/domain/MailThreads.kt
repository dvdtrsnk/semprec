package cz.semprec.app.domain

/** A name and an address as the mail API lists them; [name] is empty when the address has no display name. */
data class MailAddress(val name: String, val address: String)

/** A project, a company, a mailbox or an area that a mail value points at. */
data class MailNamedRef(val id: String, val name: String)

/** The boxes the thread list offers; `INBOX` is the default list without drafts and junk. */
enum class MailBox { INBOX, FLAGGED, SEMP_DRAFTS }

/** What the thread list is asked for; [cursor] continues a list after the last thread of the page before. */
data class MailThreadQuery(
    val box: MailBox = MailBox.INBOX,
    val mailboxId: String? = null,
    val folderId: String? = null,
    val areaId: String? = null,
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

data class MailThreadPage(val threads: List<MailThreadSummary>, val nextCursor: String?)

/** An area or a project of the filter with the number of threads it holds; [areaId] is a project's area. */
data class MailFacetOption(
    val id: String,
    val name: String,
    val color: String?,
    val count: Int,
    val areaId: String?,
)

/** The thread counts of the filter: [total] over everything, one option per area and per project. */
data class MailFacets(
    val total: Int,
    val areasTotal: Int,
    val projectsTotal: Int,
    val areas: List<MailFacetOption>,
    val projects: List<MailFacetOption>,
    val selectedAreaName: String?,
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

data class MailAttachment(
    val filename: String,
    val contentType: String,
    val byteSize: Long,
    val project: MailNamedRef?,
    val projectLink: MailLink?,
)

data class MailMessage(
    val emailId: String,
    val mailboxId: String?,
    val folderPurpose: String?,
    val own: Boolean,
    val from: MailAddress?,
    val to: List<MailAddress>,
    val cc: List<MailAddress>,
    val date: String?,
    val bodyText: String,
    val read: Boolean,
    val attachments: List<MailAttachment>,
)

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

/** A person suggested as a recipient. */
data class MailContact(val name: String, val address: String, val relationship: String?)
