package cz.alldots.app.data

import cz.alldots.app.domain.SempChange
import cz.alldots.app.domain.SempChangeKind
import cz.alldots.app.domain.SempContextRef
import cz.alldots.app.domain.SempMessage
import cz.alldots.app.domain.SempMessageStatus
import cz.alldots.app.domain.SempPreview
import cz.alldots.app.domain.SempRefKind
import cz.alldots.app.domain.SempReplyError
import cz.alldots.app.domain.SempRole
import cz.alldots.app.domain.SempStep
import cz.alldots.app.domain.SempStepApproval
import cz.alldots.app.domain.SempStepStatus
import cz.alldots.app.domain.SempThread
import cz.alldots.app.domain.SempThreadKind
import cz.alldots.app.domain.SempThreadRow
import cz.alldots.app.domain.SempTickHeader
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull

private const val STATE_PURGED = "purged"

internal fun threadKind(wire: String): SempThreadKind? = when (wire) {
    "chat" -> SempThreadKind.CHAT
    "item" -> SempThreadKind.ITEM
    "tick" -> SempThreadKind.TICK
    else -> null
}

internal fun SempThreadRowDto.toDomain(): SempThreadRow? {
    val threadKind = threadKind(kind) ?: return null
    return SempThreadRow(
        id = id,
        kind = threadKind,
        title = title,
        preview = preview?.toPreview(),
        lastActivityAt = lastActivityAt,
        hasPendingApproval = hasPendingApproval,
        projectName = heartbeat?.projectName,
        subjectInboxItemId = subject?.inboxItemId,
    )
}

/** The preview is a string, or `{ key, params }` for a system message; anything else has no preview. */
private fun JsonElement.toPreview(): SempPreview? = when (this) {
    is JsonPrimitive -> if (isString) SempPreview(content, null) else null
    is JsonObject -> (get("key") as? JsonPrimitive)?.contentOrNull?.let { SempPreview(null, it) }
    else -> null
}

internal fun SempThreadDetailDto.toDomain(): SempThread? {
    val threadKind = threadKind(kind) ?: return null
    return SempThread(
        id = id,
        kind = threadKind,
        title = title,
        subjectInboxItemId = subject?.inboxItemId,
        tick = heartbeat?.let {
            SempTickHeader(it.id, it.name, it.enabled, it.projectItemId, it.projectName, it.canTrigger)
        },
        activeRunId = activeRun?.agentRunId,
    )
}

internal fun SempMessageDto.toDomain(): SempMessage? {
    val messageRole = when (role) {
        "user" -> SempRole.USER
        "assistant" -> SempRole.ASSISTANT
        "system" -> SempRole.SYSTEM
        else -> return null
    }
    return SempMessage(
        id = id,
        role = messageRole,
        text = text,
        systemKey = system?.key,
        context = context.orEmpty().map { it.toContextRef() },
        replyToMessageId = replyToMessageId,
        attempt = attempt ?: 1,
        replaced = replaced == true,
        agentRunId = agentRunId,
        status = when (status) {
            "queued" -> SempMessageStatus.QUEUED
            "running" -> SempMessageStatus.RUNNING
            "error" -> SempMessageStatus.ERROR
            else -> SempMessageStatus.DONE
        },
        createdAt = createdAt,
        changes = changes.orEmpty().mapNotNull { it.toDomain() },
        steps = steps.orEmpty().mapNotNull { it.toDomain() },
        incomplete = outcome == "incomplete",
        error = error?.let { SempReplyError(it.code, it.message) },
    )
}

private fun SempChangeDto.toDomain(): SempChange? {
    val changeKind = when (change) {
        "created" -> SempChangeKind.CREATED
        "updated" -> SempChangeKind.UPDATED
        "deleted" -> SempChangeKind.DELETED
        "restored" -> SempChangeKind.RESTORED
        "revised" -> SempChangeKind.REVISED
        else -> return null
    }
    return SempChange(
        itemId = itemId,
        databaseId = databaseId,
        kind = changeKind,
        label = (resolved?.label as? JsonPrimitive)?.contentOrNull,
        databaseKey = resolved?.databaseKey,
        active = resolved?.state == "active",
    )
}

private fun SempStepDto.toDomain(): SempStep? {
    val stepStatus = when (status) {
        "ok" -> SempStepStatus.OK
        "wait" -> SempStepStatus.WAIT
        "error" -> SempStepStatus.ERROR
        else -> return null
    }
    return SempStep(
        status = stepStatus,
        durationMs = durationMs,
        approvalRequestId = approvalRequestId,
        approval = approval?.let { SempStepApproval(it.status, it.executionStatus, it.conflictReason?.key) },
    )
}

private fun JsonObject.string(name: String): String? = (get(name) as? JsonPrimitive)?.contentOrNull

/** One stored reference of a user message, with the label the server resolved for it. */
private fun JsonObject.toContextRef(): SempContextRef {
    val refKind = when (string("kind")) {
        "item", "taskTrace" -> SempRefKind.ITEM
        "block" -> SempRefKind.BLOCK
        "transcriptSegment" -> SempRefKind.TRANSCRIPT_SEGMENT
        "mailAttachment" -> SempRefKind.MAIL_ATTACHMENT
        "mailThread" -> SempRefKind.MAIL_THREAD
        "agentRun" -> SempRefKind.AGENT_RUN
        "approvalRequest" -> SempRefKind.APPROVAL_REQUEST
        else -> SempRefKind.OTHER
    }
    val resolved = get("resolved") as? JsonObject
    val id = string("itemId") ?: string("threadId") ?: string("agentRunId") ?: string("approvalRequestId")
        ?: string("attachmentId")
    return SempContextRef(
        kind = refKind,
        id = id,
        databaseId = string("databaseId"),
        databaseKey = resolved?.string("databaseKey"),
        label = resolved?.string("label") ?: string("label"),
        exists = resolved?.string("state") != STATE_PURGED,
    )
}
