package cz.semprec.app.data

import cz.semprec.app.core.MailSignalField
import kotlinx.serialization.Serializable
import kotlinx.serialization.SerializationException

// The wire shapes of `/api/mail/projects/:projectId/signals`. Unknown fields are ignored.

@Serializable
internal data class MailSignalPersonDto(val personId: String, val name: String = "", val address: String)

@Serializable
internal data class ProjectMailSignalsDto(
    val projectId: String,
    val domains: List<String> = emptyList(),
    val addresses: List<String> = emptyList(),
    val keywords: List<String> = emptyList(),
    val updatedAt: String? = null,
    val peopleAddresses: List<MailSignalPersonDto> = emptyList(),
)

/** The body of a save and the draft of a preview; no defaults, so that every list is sent, an empty one too. */
@Serializable
internal data class MailSignalSetBody(
    val domains: List<String>,
    val addresses: List<String>,
    val keywords: List<String>,
)

@Serializable
internal data class MailSignalPreviewBody(val draft: MailSignalSetBody)

@Serializable
internal data class MailSignalPreviewDto(
    val total: Int,
    val alreadyAssigned: Int = 0,
    val threads: List<MailThreadDto> = emptyList(),
)

@Serializable
internal data class MailSignalApplyBody(val threadIds: List<String>)

@Serializable
internal data class MailSignalAssignmentDto(val assigned: Int, val skipped: Int)

@Serializable
internal data class MailSignalErrorDto(val error: MailSignalErrorBodyDto? = null)

@Serializable
internal data class MailSignalErrorBodyDto(val code: String? = null, val details: MailSignalErrorDetailsDto? = null)

@Serializable
internal data class MailSignalErrorDetailsDto(val field: String? = null)

/**
 * The list a `400 validation_failed` names in `error.details.field`, or `null` for another answer or a field that is
 * not one of the lists.
 */
internal fun ApiResponse.Failure.invalidSignalField(): MailSignalField? {
    val error = body?.let { text ->
        try {
            ApiJson.decodeFromString(MailSignalErrorDto.serializer(), text).error
        } catch (_: SerializationException) {
            null
        } catch (_: IllegalArgumentException) {
            null
        }
    }
    return when (error?.details?.field?.takeIf { error.code == "validation_failed" }) {
        "domains" -> MailSignalField.DOMAINS
        "addresses" -> MailSignalField.ADDRESSES
        "keywords" -> MailSignalField.KEYWORDS
        else -> null
    }
}
