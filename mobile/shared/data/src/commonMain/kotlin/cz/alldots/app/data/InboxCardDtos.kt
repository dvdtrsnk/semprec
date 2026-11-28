package cz.alldots.app.data

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject

/** `GET /api/inbox/cards`. */
@Serializable
internal data class InboxCardsDto(val cards: List<InboxCardDto> = emptyList(), val total: Int = 0)

/** `GET /api/inbox/cards/count`. */
@Serializable
internal data class InboxCountDto(val total: Int = 0)

/** One card of the stack as the list answers it; [envelope] and [context] are read as trees, by the mapper. */
@Serializable
internal data class InboxCardDto(
    val cardId: String,
    val source: String = "proposal",
    val cardKind: String = "",
    val baseKind: String = "",
    val status: String = "",
    val computeTimedOut: Boolean = false,
    val version: String? = null,
    val resolvedSource: InboxSourceDto? = null,
    val context: JsonElement? = null,
    val targets: List<InboxTargetDto> = emptyList(),
    val envelope: JsonElement? = null,
    val invalidReason: InboxInvalidDto? = null,
    val editorSchema: InboxSchemaDto? = null,
)

/** What the card was made from; [kind] is `inboxItem`, `transcript` or `run`, and the other fields follow it. */
@Serializable
internal data class InboxSourceDto(
    val kind: String = "",
    val id: String? = null,
    val text: String? = null,
    val date: String? = null,
    val time: String? = null,
    val type: InboxSourceTypeDto? = null,
    val name: String? = null,
    val completedAt: String? = null,
    val sourceKind: String? = null,
    val threadTitle: String? = null,
    val heartbeatName: String? = null,
    val mcpClientName: String? = null,
)

@Serializable
internal data class InboxSourceTypeDto(val id: String = "", val name: String = "", val emoji: String = "")

@Serializable
internal data class InboxTargetDto(val databaseKey: String = "", val label: String = "")

@Serializable
internal data class InboxInvalidDto(val code: String = "unknown", val field: String = "", val text: String = "")

@Serializable
internal data class InboxSchemaDto(val baseKind: String = "", val groups: List<InboxGroupDto> = emptyList())

@Serializable
internal data class InboxGroupDto(val key: String = "", val fields: List<InboxFieldDto> = emptyList())

@Serializable
internal data class InboxFieldDto(
    val key: String,
    val control: String = "",
    val inputType: String? = null,
    val label: String = "",
    val placeholder: String? = null,
    val required: Boolean = false,
    val `when`: InboxConditionDto? = null,
    val timeHiddenWhen: InboxConditionDto? = null,
    val optionsSource: String? = null,
    val options: List<String> = emptyList(),
    val info: String? = null,
)

/** `{ field, equals }` or `{ field, notEquals }`; the compared value is a string, a number or a boolean. */
@Serializable
internal data class InboxConditionDto(
    val field: String = "",
    val equals: JsonElement? = null,
    val notEquals: JsonElement? = null,
)

/** `GET /api/inbox-types`. */
@Serializable
internal data class InboxTypesDto(val types: List<InboxTypeDto> = emptyList())

@Serializable
internal data class InboxTypeDto(
    val id: String,
    val emoji: String = "",
    val label: String = "",
    val targetLabel: String? = null,
)

/** `GET /api/proposals/:id/options`. */
@Serializable
internal data class InboxOptionsDto(val options: List<InboxOptionDto> = emptyList())

@Serializable
internal data class InboxOptionDto(
    val id: String? = null,
    val ref: String? = null,
    val label: String = "",
    val color: String? = null,
    val initials: String? = null,
    val disabled: Boolean = false,
    val hint: String? = null,
    val suggested: Boolean = false,
    val none: Boolean = false,
)

/**
 * The card item every write answers: the item envelope with the card's properties (its status, effective proposal and
 * the person's own values), its [version] (the `ifVersion` of the next decision), and what a confirmation did.
 */
@Serializable
internal data class InboxItemDto(
    val id: String = "",
    val properties: JsonObject = JsonObject(emptyMap()),
    val version: String = "",
    val results: List<InboxResultDto> = emptyList(),
)

@Serializable
internal data class InboxResultDto(
    val itemId: String = "",
    val databaseKey: String? = null,
    val label: String = "",
    val role: String = "",
)

/** `GET /api/approval-requests/:id`, as far as a card shows it. */
@Serializable
internal data class InboxApprovalDto(
    val toolName: String = "",
    val riskLevel: String = "",
    val reason: String? = null,
    val safeSummary: InboxSafeSummaryDto? = null,
)

@Serializable
internal data class InboxSafeSummaryDto(
    val operationName: String? = null,
    val toolName: String? = null,
    val mcpServerName: String? = null,
    val mcpToolName: String? = null,
)
