package cz.semprec.app.data

import kotlinx.serialization.Serializable

// The wire shapes of `/api/mail/messages/:emailId/*`. Unknown fields are ignored.

/** The answer of `GET …/content`; the app shows the plain text, so the HTML body and the cache times are not read. */
@Serializable
internal data class MailMessageContentDto(val emailId: String, val bodyText: String = "")

/** The answer of `POST …/attachments/:attachmentId/save`. */
@Serializable
internal data class MailAttachmentSavedDto(val fileItemId: String)

/** The error answer `{ "error": { "code", "details": { "reason" } } }` of a fetch the provider could not serve. */
@Serializable
internal data class MailContentErrorDto(val error: MailContentErrorBodyDto? = null)

@Serializable
internal data class MailContentErrorBodyDto(val code: String? = null, val details: MailContentErrorDetailsDto? = null)

@Serializable
internal data class MailContentErrorDetailsDto(val reason: String? = null)
