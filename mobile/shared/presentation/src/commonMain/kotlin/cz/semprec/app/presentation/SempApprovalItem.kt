package cz.semprec.app.presentation

import cz.semprec.app.core.FailureKind
import cz.semprec.app.domain.SempApproval
import cz.semprec.app.domain.SempApprovalExecution
import cz.semprec.app.domain.SempApprovalRisk
import cz.semprec.app.domain.SempApprovalSource
import cz.semprec.app.domain.SempApprovalStatus

/** How much a request can hurt, as the server classifies it. */
enum class SempRisk { IRREVERSIBLE, OUTBOUND, BREAKS_LINK, WRITE }

/** Where a request came from: a chat, an automatic task, or an app that calls Semp over MCP. */
enum class SempOrigin { CHAT, TICK, MCP }

/**
 * Where a request stands. [APPROVING] and [REJECTING] are a decision on its way to the server; [QUEUED] is approved
 * and waiting to be carried out; [CONFLICT] is approved but not carried out because the data changed meanwhile.
 */
enum class SempDecisionState { PENDING, APPROVING, REJECTING, QUEUED, EXECUTED, REJECTED, CONFLICT }

/**
 * One approval request. The description is a template [descriptionKey] with its [descriptionParams] (names and
 * counts), never rendered text; the app writes it in its own language. [decisionFailed] is set when the last try to
 * decide it did not reach the server.
 */
data class SempApprovalItem(
    val id: String,
    val descriptionKey: String?,
    val descriptionParams: Map<String, String>,
    val callLabel: String?,
    val argumentKeys: List<String>,
    val risk: SempRisk,
    val origin: SempOrigin,
    val threadId: String?,
    val threadTitle: String?,
    val heartbeatName: String?,
    val projectName: String?,
    val requestedAt: String,
    val runId: String,
    val breaksLink: Boolean,
    val decision: SempDecisionState,
    val conflictKey: String?,
    val decisionFailed: Boolean = false,
    val decisionFailure: FailureKind? = null,
)

internal fun SempApproval.toItem(): SempApprovalItem = SempApprovalItem(
    id = id,
    descriptionKey = description?.key,
    descriptionParams = description?.params.orEmpty(),
    callLabel = call.label ?: toolName,
    argumentKeys = call.argumentKeys,
    risk = when (risk) {
        SempApprovalRisk.IRREVERSIBLE -> SempRisk.IRREVERSIBLE
        SempApprovalRisk.OUTBOUND -> SempRisk.OUTBOUND
        SempApprovalRisk.BREAKS_LINK -> SempRisk.BREAKS_LINK
        SempApprovalRisk.WRITE -> SempRisk.WRITE
    },
    origin = when (source) {
        SempApprovalSource.CHAT -> SempOrigin.CHAT
        SempApprovalSource.TICK -> SempOrigin.TICK
        SempApprovalSource.MCP -> SempOrigin.MCP
    },
    threadId = threadId,
    threadTitle = threadTitle,
    heartbeatName = heartbeatName,
    projectName = projectName,
    requestedAt = requestedAt,
    runId = runId,
    breaksLink = breaksLink,
    decision = decisionState(),
    conflictKey = conflictKey,
)

private fun SempApproval.decisionState(): SempDecisionState = when (status) {
    SempApprovalStatus.PENDING -> SempDecisionState.PENDING
    SempApprovalStatus.REJECTED -> SempDecisionState.REJECTED
    SempApprovalStatus.APPROVED -> when (execution) {
        SempApprovalExecution.QUEUED, SempApprovalExecution.NOT_RUN -> SempDecisionState.QUEUED
        SempApprovalExecution.SUCCEEDED -> SempDecisionState.EXECUTED
        SempApprovalExecution.CONFLICT -> SempDecisionState.CONFLICT
    }
}
