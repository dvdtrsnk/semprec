package cz.alldots.app.data

import cz.alldots.app.domain.SempRefInput
import cz.alldots.app.domain.SempRefKind
import cz.alldots.app.domain.SempThreadKind

internal fun SempThreadKind.wire(): String = when (this) {
    SempThreadKind.CHAT -> "chat"
    SempThreadKind.ITEM -> "item"
    SempThreadKind.TICK -> "tick"
}

internal fun SempRefInput.toBody(): SempRefBodyDto? = when (kind) {
    SempRefKind.ITEM -> databaseId?.let { SempRefBodyDto("item", itemId = id, databaseId = it) }
    SempRefKind.MAIL_THREAD -> SempRefBodyDto("mailThread", threadId = id)
    SempRefKind.AGENT_RUN -> SempRefBodyDto("agentRun", agentRunId = id)
    SempRefKind.APPROVAL_REQUEST -> SempRefBodyDto("approvalRequest", approvalRequestId = id)
    SempRefKind.BLOCK,
    SempRefKind.TRANSCRIPT_SEGMENT,
    SempRefKind.MAIL_ATTACHMENT,
    SempRefKind.OTHER,
    -> null
}
