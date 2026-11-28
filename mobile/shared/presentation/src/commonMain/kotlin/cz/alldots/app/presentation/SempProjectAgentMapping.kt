package cz.alldots.app.presentation

import cz.alldots.app.domain.SempDriftFinding
import cz.alldots.app.domain.SempDriftKind
import cz.alldots.app.domain.SempGuidance
import cz.alldots.app.domain.SempProjectRun
import cz.alldots.app.domain.SempProjectTask
import cz.alldots.app.domain.SempRunStatus
import cz.alldots.app.domain.SempRunTrigger
import cz.alldots.app.domain.SempToolGrant

internal fun SempGuidance.toSections() = SempSections(purpose, allowed, notAllowed, general)

internal fun SempGuidance.with(section: SempSection, text: String): SempGuidance = when (section) {
    SempSection.PURPOSE -> copy(purpose = text)
    SempSection.ALLOWED -> copy(allowed = text)
    SempSection.NOT_ALLOWED -> copy(notAllowed = text)
    SempSection.GENERAL -> copy(general = text)
}

/** A permission finding has no line to add; the person can only close it. */
internal fun SempDriftFinding.toFinding() = SempFinding(
    id = id,
    kind = when (kind) {
        SempDriftKind.PERMISSION -> SempFindingKind.PERMISSION
        SempDriftKind.BEHAVIOR -> SempFindingKind.BEHAVIOR
    },
    claim = claim,
    blocking = blocking,
    canAllow = kind == SempDriftKind.BEHAVIOR && suggestedAllowedLine != null,
    canForbid = kind == SempDriftKind.BEHAVIOR && suggestedNotAllowedLine != null,
)

/** The tools grouped by the server that offers them, in the order the servers first appear. */
internal fun List<SempToolGrant>.toServers(): List<SempToolServer> =
    groupBy { it.serverId }.map { (id, grants) ->
        SempToolServer(
            id = id,
            name = grants.first().serverName,
            online = grants.first().serverOnline,
            tools = grants.map { SempToolRow(it.registrationId, it.label, it.requiresApproval, it.granted) },
        )
    }

internal fun List<SempToolServer>.withTool(registrationId: String, granted: Boolean): List<SempToolServer> =
    map { server ->
        server.copy(
            tools = server.tools.map { if (it.registrationId == registrationId) it.copy(granted = granted) else it },
        )
    }

internal fun SempProjectTask.toRow() = SempTaskRow(
    id = id,
    name = name,
    ruleLabel = ruleLabel,
    enabled = enabled,
    threadId = threadId,
    lastAt = lastAt,
    lastFailed = lastFailed,
    lastWaiting = lastWaiting,
    lastErrorSummary = lastErrorSummary,
)

internal fun SempProjectRun.toRow() = SempAgentRunRow(
    id = id,
    runId = runId,
    messageId = messageId,
    title = title,
    trigger = when (trigger) {
        SempRunTrigger.USER -> SempRunTriggerKind.USER
        SempRunTrigger.TICK -> SempRunTriggerKind.TICK
        SempRunTrigger.MCP -> SempRunTriggerKind.MCP
        SempRunTrigger.SUPERVISOR -> SempRunTriggerKind.SUPERVISOR
    },
    startedAt = startedAt,
    durationMs = durationMs,
    costUsd = costUsd,
    display = when (status) {
        SempRunStatus.RUNNING -> SempRunDisplay.RUNNING
        SempRunStatus.DONE -> SempRunDisplay.DONE
        SempRunStatus.WAITING_APPROVAL -> SempRunDisplay.WAITING_APPROVAL
        SempRunStatus.ERROR -> SempRunDisplay.ERROR
    },
    errorSummary = errorSummary,
)
