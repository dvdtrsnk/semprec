package cz.alldots.app.presentation

import cz.alldots.app.core.FailureKind

enum class SempAgentPhase { LOADING, READY, ERROR }

/** Where the saving of the instructions stands. [CONFLICT] is a save that met newer instructions and took them. */
enum class SempSaveState { IDLE, SAVING, SAVED, FAILED, CONFLICT }

/** The four parts of the project's instructions (AGENT.md). */
enum class SempSection { PURPOSE, ALLOWED, NOT_ALLOWED, GENERAL }

data class SempSections(val purpose: String, val allowed: String, val notAllowed: String, val general: String)

enum class SempFindingKind { PERMISSION, BEHAVIOR }

/**
 * Something Semp does, or is told, that the instructions do not agree with. [canAllow] and [canForbid] say which
 * answers add a line to the instructions; every finding can be [dismissed][SempProjectAgentAction.ResolveDrift].
 */
data class SempFinding(
    val id: String,
    val kind: SempFindingKind,
    val claim: String,
    val blocking: Boolean,
    val canAllow: Boolean,
    val canForbid: Boolean,
)

data class SempToolRow(
    val registrationId: String,
    val label: String,
    val requiresApproval: Boolean,
    val granted: Boolean,
)

data class SempToolServer(val id: String, val name: String, val online: Boolean, val tools: List<SempToolRow>)

/** An automatic task of the project. [lastErrorSummary] is the server's text when the last run failed. */
data class SempTaskRow(
    val id: String,
    val name: String,
    val ruleLabel: String,
    val enabled: Boolean,
    val threadId: String?,
    val lastAt: String?,
    val lastFailed: Boolean,
    val lastWaiting: Boolean,
    val lastErrorSummary: String?,
)

/** One run of the project's agent; [messageId] is set for one answer of a chat run. */
data class SempAgentRunRow(
    val id: String,
    val runId: String,
    val messageId: String?,
    val title: String,
    val trigger: SempRunTriggerKind,
    val startedAt: String,
    val durationMs: Long?,
    val costUsd: Double,
    val display: SempRunDisplay,
    val errorSummary: String?,
)

data class SempProjectAgentState(
    val phase: SempAgentPhase = SempAgentPhase.LOADING,
    val failure: FailureKind? = null,
    val projectName: String? = null,
    val sections: SempSections = SempSections("", "", "", ""),
    val saveState: SempSaveState = SempSaveState.IDLE,
    val finding: SempFinding? = null,
    val servers: List<SempToolServer> = emptyList(),
    val tasks: List<SempTaskRow> = emptyList(),
    val runs: List<SempAgentRunRow> = emptyList(),
    val partialFailure: Boolean = false,
    val changeFailed: Boolean = false,
)

enum class SempDriftAnswer { ALLOW, FORBID, DISMISS }

sealed interface SempProjectAgentAction {
    data object Retry : SempProjectAgentAction

    data class SaveSection(val section: SempSection, val text: String) : SempProjectAgentAction

    data object RetrySave : SempProjectAgentAction

    data class ResolveDrift(val answer: SempDriftAnswer) : SempProjectAgentAction

    data class SetTool(val registrationId: String, val granted: Boolean) : SempProjectAgentAction

    data class SetTask(val taskId: String, val enabled: Boolean) : SempProjectAgentAction

    data class OpenTask(val taskId: String) : SempProjectAgentAction

    data class OpenRun(val rowId: String) : SempProjectAgentAction

    data object DismissFailure : SempProjectAgentAction
}

sealed interface SempProjectAgentEffect {
    data class OpenThread(val threadId: String) : SempProjectAgentEffect

    data class OpenRun(val runId: String, val messageId: String?) : SempProjectAgentEffect
}
