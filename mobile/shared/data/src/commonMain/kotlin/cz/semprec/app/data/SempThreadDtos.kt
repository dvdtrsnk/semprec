package cz.semprec.app.data

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject

/** `GET /api/semp/threads`. */
@Serializable
internal data class SempThreadListDto(val rows: List<SempThreadRowDto>, val nextCursor: String? = null)

@Serializable
internal data class SempThreadRowDto(
    val id: String,
    val kind: String,
    val title: String? = null,
    /** Either the text of the last message, or `{ key, params }` for a system message. */
    val preview: JsonElement? = null,
    val lastActivityAt: String,
    val hasPendingApproval: Boolean = false,
    val heartbeat: SempListHeartbeatDto? = null,
    val subject: SempSubjectDto? = null,
)

@Serializable
internal data class SempListHeartbeatDto(val projectName: String? = null)

@Serializable
internal data class SempSubjectDto(val inboxItemId: String? = null)

/** `GET /api/semp/threads/:id`. */
@Serializable
internal data class SempThreadDetailDto(
    val id: String,
    val kind: String,
    val title: String? = null,
    val subject: SempSubjectDto? = null,
    val heartbeat: SempHeartbeatDto? = null,
    val activeRun: SempActiveRunDto? = null,
)

@Serializable
internal data class SempHeartbeatDto(
    val id: String,
    val name: String,
    val enabled: Boolean,
    val projectItemId: String,
    val projectName: String? = null,
    val canTrigger: Boolean = false,
)

@Serializable
internal data class SempActiveRunDto(val agentRunId: String)

/** `GET /api/semp/threads/:id/messages`. */
@Serializable
internal data class SempMessageListDto(val rows: List<SempMessageDto>, val nextCursor: String? = null)

@Serializable
internal data class SempMessageDto(
    val id: String,
    val role: String,
    val text: String? = null,
    val system: SempSystemDto? = null,
    val context: List<JsonObject>? = null,
    val replyToMessageId: String? = null,
    val attempt: Int? = null,
    val replaced: Boolean? = null,
    val agentRunId: String? = null,
    val status: String? = null,
    val createdAt: String,
    val changes: List<SempChangeDto>? = null,
    val steps: List<SempStepDto>? = null,
    val outcome: String? = null,
    val error: SempErrorDto? = null,
)

@Serializable
internal data class SempSystemDto(val key: String)

@Serializable
internal data class SempChangeDto(
    val itemId: String,
    val databaseId: String,
    val change: String,
    val resolved: SempResolvedDto? = null,
)

@Serializable
internal data class SempResolvedDto(
    val label: JsonElement? = null,
    val databaseKey: String? = null,
    val state: String? = null,
)

@Serializable
internal data class SempStepDto(
    val status: String,
    val durationMs: Long = 0,
    val approvalRequestId: String? = null,
    val approval: SempStepApprovalDto? = null,
)

@Serializable
internal data class SempStepApprovalDto(
    val status: String,
    val executionStatus: String,
    val conflictReason: SempConflictDto? = null,
)

@Serializable
internal data class SempConflictDto(val key: String? = null)

@Serializable
internal data class SempErrorDto(val code: String, val message: String)

/** `POST /api/semp/threads` and `POST /api/semp/threads/:id/messages`. */
@Serializable
internal data class SempSendReceiptDto(val threadId: String, val messageId: String, val assistantMessageId: String)

@Serializable
internal data class SempSendBodyDto(
    val text: String,
    val context: List<SempRefBodyDto>? = null,
    val subject: SempSendSubjectDto? = null,
)

@Serializable
internal data class SempSendSubjectDto(val inboxItemId: String)

/** A reference as the server's `context` takes it: `kind` with the id fields of that kind. */
@Serializable
internal data class SempRefBodyDto(
    val kind: String,
    val itemId: String? = null,
    val databaseId: String? = null,
    val threadId: String? = null,
    val agentRunId: String? = null,
    val approvalRequestId: String? = null,
)
