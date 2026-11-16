package cz.semprec.app.data

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

// The wire shapes of `/api/mail/*`. Unknown fields are ignored; an unknown value of an enum is an unreadable answer.

@Serializable
internal data class MailAddressDto(val name: String = "", val address: String)

@Serializable
internal data class MailMailboxRefDto(val id: String, val name: String = "")

@Serializable
internal data class MailPersonRefDto(val id: String, val name: String = "", val relationship: String? = null)

@Serializable
internal data class MailNamedDto(val id: String, val name: String = "")

@Serializable
internal data class MailThreadLinksDto(val company: ValueLinkDto? = null, val project: ValueLinkDto? = null)

@Serializable
internal data class MailThreadDto(
    val threadId: String,
    val subject: String = "",
    val lastMessageAt: String,
    val lastSender: MailAddressDto,
    val messageCount: Int = 0,
    val preview: String? = null,
    val hasAttachment: Boolean = false,
    val unread: Boolean = false,
    val flagged: Boolean = false,
    val mailboxes: List<MailMailboxRefDto> = emptyList(),
    val senderPerson: MailPersonRefDto? = null,
    val project: MailNamedDto? = null,
    val company: MailNamedDto? = null,
    val hasSempDraft: Boolean = false,
)

@Serializable
internal data class MailThreadPageDto(val threads: List<MailThreadDto> = emptyList(), val nextCursor: String? = null)

@Serializable
internal data class MailFacetItemDto(val id: String, val count: Int = 0, val areaId: String? = null)

@Serializable
internal data class MailFacetGroupDto(val total: Int = 0, val items: List<MailFacetItemDto> = emptyList())

@Serializable
internal data class MailFacetsDto(
    val total: Int = 0,
    val areas: MailFacetGroupDto = MailFacetGroupDto(),
    val projects: MailFacetGroupDto = MailFacetGroupDto(),
)

@Serializable
internal data class MailSummaryDto(
    val unreadInbox: Int = 0,
    val flagged: Int = 0,
    val sempDrafts: Int = 0,
    val accounts: Int = 0,
    val accountsNeedingReauth: List<MailNamedDto> = emptyList(),
)

@Serializable
internal data class MailAttachmentLinksDto(val project: ValueLinkDto? = null)

@Serializable
internal data class MailAttachmentDto(
    val filename: String,
    val contentType: String = "",
    val byteSize: Long = 0,
    val project: MailNamedDto? = null,
    val links: MailAttachmentLinksDto = MailAttachmentLinksDto(),
)

@Serializable
internal data class MailMessageDto(
    val emailId: String,
    val mailboxId: String? = null,
    val folderPurpose: String? = null,
    val isOwn: Boolean = false,
    val from: MailAddressDto? = null,
    val to: List<MailAddressDto> = emptyList(),
    val cc: List<MailAddressDto> = emptyList(),
    val date: String? = null,
    val bodyText: String = "",
    val read: Boolean = false,
    val attachments: List<MailAttachmentDto> = emptyList(),
)

/** A project or a person of a task; a trashed one has [state] `trashed` and no name. */
@Serializable
internal data class MailTaskRefDto(val id: String, val state: String = "active", val name: String? = null)

@Serializable
internal data class MailTaskLinksDto(val project: ValueLinkDto? = null, val people: ValueLinkDto? = null)

@Serializable
internal data class MailTaskDto(
    val id: String,
    val name: String = "",
    val date: String? = null,
    val status: String = "",
    val project: MailTaskRefDto? = null,
    val people: List<MailTaskRefDto> = emptyList(),
    val links: MailTaskLinksDto = MailTaskLinksDto(),
)

@Serializable
internal data class MailThreadDetailDto(
    val threadId: String,
    val subject: String = "",
    val messageCount: Int = 0,
    val unread: Boolean = false,
    val flagged: Boolean = false,
    val mailboxes: List<MailMailboxRefDto> = emptyList(),
    val lastSender: MailAddressDto,
    val senderPerson: MailPersonRefDto? = null,
    val project: MailNamedDto? = null,
    val company: MailNamedDto? = null,
    val links: MailThreadLinksDto = MailThreadLinksDto(),
    val messages: List<MailMessageDto> = emptyList(),
    val tasks: List<MailTaskDto> = emptyList(),
)

@Serializable
internal data class MailReadDto(val threadId: String, val unread: Boolean)

@Serializable
internal data class MailFlagDto(val threadId: String, val flagged: Boolean)

@Serializable
internal data class MailTaskCreatedDto(val id: String, val name: String = "")

@Serializable
internal data class MailContactDto(val name: String = "", val email: String, val relationship: String? = null)

@Serializable
internal data class MailContactsDto(val contacts: List<MailContactDto> = emptyList())

@Serializable
internal enum class MailDraftModeDto {
    @SerialName("new") NEW,

    @SerialName("reply") REPLY,

    @SerialName("replyAll") REPLY_ALL,

    @SerialName("forward") FORWARD,
}

@Serializable
internal enum class MailActorDto {
    @SerialName("user") USER,

    @SerialName("agent") AGENT,
}

@Serializable
internal data class MailDraftDto(
    val id: String,
    val mailboxId: String,
    val from: String,
    val to: List<MailAddressDto> = emptyList(),
    val cc: List<MailAddressDto> = emptyList(),
    val bcc: List<MailAddressDto> = emptyList(),
    val subject: String = "",
    val body: String = "",
    val threadId: String? = null,
    val mode: MailDraftModeDto = MailDraftModeDto.NEW,
    val sourceEmailId: String? = null,
    val createdBy: MailActorDto = MailActorDto.USER,
    val updatedAt: String,
)

@Serializable
internal data class MailSentDto(val emailId: String, val threadId: String, val mailbox: MailNamedDto)

@Serializable
internal enum class MailSyncStatusDto {
    @SerialName("ok") OK,

    @SerialName("error") ERROR,

    @SerialName("never") NEVER,

    @SerialName("needsReauthorization") NEEDS_REAUTHORIZATION,
}

@Serializable
internal data class MailConnectionLimitDto(val value: Int, val applies: Boolean = false)

@Serializable
internal data class MailMailboxDto(
    val id: String,
    val name: String = "",
    val provider: String? = null,
    val primaryAddress: String? = null,
    val syncMode: String = "",
    val syncStatus: MailSyncStatusDto? = null,
    val initialSyncInProgress: Boolean = false,
    val lastSuccessfulSyncAt: String? = null,
    val failingSince: String? = null,
    val connectionLimit: MailConnectionLimitDto,
    val autonomousSendProjectCount: Int = 0,
)

@Serializable
internal data class MailMailboxListDto(val mailboxes: List<MailMailboxDto> = emptyList())

@Serializable
internal data class MailFolderDto(
    val id: String,
    val name: String = "",
    val specialPurpose: String = "none",
    val unreadCount: Int = 0,
    val totalCount: Int = 0,
)

@Serializable
internal data class MailRemovalImpactDto(
    val messages: Int = 0,
    val drafts: Int = 0,
    val threads: Int = 0,
    val attachmentsKept: Int = 0,
)
