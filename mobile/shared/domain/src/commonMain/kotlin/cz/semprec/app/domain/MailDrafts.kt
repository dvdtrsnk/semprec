package cz.semprec.app.domain

enum class MailDraftMode { NEW, REPLY, REPLY_ALL, FORWARD }

/** A saved draft of the signed-in person's mail; [version] is the `ifVersion` of its next update. */
data class MailDraft(
    val id: String,
    val mailboxId: String,
    val from: String,
    val to: List<MailAddress>,
    val cc: List<MailAddress>,
    val bcc: List<MailAddress>,
    val subject: String,
    val body: String,
    val threadId: String?,
    val mode: MailDraftMode,
    val sourceEmailId: String?,
    val createdByAgent: Boolean,
    val version: String,
)

/** The fields the person edits in a draft; the server computes everything else. */
data class MailDraftFields(
    val mailboxId: String,
    val from: String,
    val to: List<MailAddress>,
    val cc: List<MailAddress>,
    val bcc: List<MailAddress>,
    val subject: String,
    val body: String,
)

/** The reply, reply-all or forward of one message: the server fills recipients, subject and quote from it. */
data class MailPrefill(
    val mailboxId: String,
    val mode: MailDraftMode,
    val sourceEmailId: String,
    val body: String,
)

data class MailSentDraft(val emailId: String, val threadId: String, val mailboxName: String)
