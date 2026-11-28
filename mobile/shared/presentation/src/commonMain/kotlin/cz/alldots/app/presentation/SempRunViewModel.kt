package cz.alldots.app.presentation

import androidx.lifecycle.viewModelScope
import cz.alldots.app.core.FailureKind
import cz.alldots.app.domain.LoadSempRun
import cz.alldots.app.domain.LoadSempRunSteps
import cz.alldots.app.domain.RepositoryResult
import cz.alldots.app.domain.RetrySempRun
import cz.alldots.app.domain.SempRun
import cz.alldots.app.domain.SempRunStatus
import cz.alldots.app.domain.SempRunStep
import cz.alldots.app.domain.SempRunStepKind
import cz.alldots.app.domain.SempRunStepState
import cz.alldots.app.domain.SempRunTrigger
import kotlinx.coroutines.Job
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.launch

enum class SempRunPhase { LOADING, READY, ERROR }

/** What a client shows as the state of a run; [WAITING_APPROVAL] is a run that asked for a decision. */
enum class SempRunDisplay { RUNNING, DONE, WAITING_APPROVAL, ERROR }

enum class SempRunTriggerKind { USER, TICK, MCP, SUPERVISOR }

enum class SempRunStepKindView { START, PLAN, TOOL, APPROVAL, ANSWER, END, ERROR }

/** What one model cost the run. */
data class SempUsageRow(
    val modelName: String,
    val calls: Int,
    val inputTokens: Long,
    val outputTokens: Long,
    val costUsd: Double,
)

data class SempRunView(
    val id: String,
    val title: String,
    val display: SempRunDisplay,
    val trigger: SempRunTriggerKind,
    val threadId: String?,
    val projectName: String?,
    val startedAt: String,
    val durationMs: Long?,
    val approvalCount: Int,
    val pendingApprovalCount: Int,
    val errorSummary: String?,
    val canRetry: Boolean,
    val totalCostUsd: Double,
    val costIsEstimate: Boolean,
    val usage: List<SempUsageRow>,
)

/** One step of the run; [title] and [summary] are the server's text in the person's language. */
data class SempRunStepRow(
    val id: String,
    val kind: SempRunStepKindView,
    val state: SempLineState,
    val title: String,
    val summary: String?,
    val at: String,
    val durationMs: Long?,
)

data class SempRunState(
    val phase: SempRunPhase = SempRunPhase.LOADING,
    val failure: FailureKind? = null,
    val run: SempRunView? = null,
    val stepsPhase: SempStepsPhase = SempStepsPhase.LOADING,
    val steps: List<SempRunStepRow> = emptyList(),
    val historyTruncated: Boolean = false,
    val retrying: Boolean = false,
    val retryFailed: Boolean = false,
)

sealed interface SempRunAction {
    data object Retry : SempRunAction

    data object RetryRun : SempRunAction

    data object OpenThread : SempRunAction

    data object OpenApprovals : SempRunAction
}

sealed interface SempRunEffect {
    data class OpenThread(val threadId: String) : SempRunEffect

    data object OpenApprovals : SempRunEffect
}

private const val RUNNING_POLL_MILLIS = 2_000L
private const val MAX_RUNNING_POLLS = 150

/**
 * One run of the agent: how it started and went (as the server wrote it), what it did step by step, and what it cost.
 * A run that is still going is read again until it ends. [messageId] narrows the run to one answer of a chat.
 */
class SempRunViewModel internal constructor(
    private val runId: String,
    private val messageId: String?,
    private val loadRun: LoadSempRun,
    private val loadSteps: LoadSempRunSteps,
    private val retryRun: RetrySempRun,
) : ScreenViewModel<SempRunState, SempRunAction, SempRunEffect>(SempRunState()) {
    private var loadJob: Job? = null

    init {
        load(initial = true)
    }

    override fun onAction(action: SempRunAction) {
        if (isClosed) return
        when (action) {
            SempRunAction.Retry -> load(initial = true)
            SempRunAction.RetryRun -> retry()
            SempRunAction.OpenThread -> state.value.run?.threadId?.let { emit(SempRunEffect.OpenThread(it)) }
            SempRunAction.OpenApprovals -> emit(SempRunEffect.OpenApprovals)
        }
    }

    private fun load(initial: Boolean) {
        loadJob?.cancel()
        if (initial) update { SempRunState() }
        loadJob = viewModelScope.launch {
            var polls = 0
            do {
                val run = read()
                if (run?.status == SempRunStatus.RUNNING) delay(RUNNING_POLL_MILLIS)
                polls++
            } while (run?.status == SempRunStatus.RUNNING && polls < MAX_RUNNING_POLLS)
        }
    }

    /** Reads the run and its steps once and shows them; answers the run, or `null` when it could not be read. */
    private suspend fun read(): SempRun? {
        val run = guarded { loadRun(runId, messageId) }
        currentCoroutineContext().ensureActive()
        when (run) {
            is RepositoryResult.Content -> update {
                it.copy(phase = SempRunPhase.READY, failure = null, run = run.value.toView())
            }
            is RepositoryResult.Failure -> update { it.copy(phase = SempRunPhase.ERROR, failure = run.kind) }
            null -> update { it.copy(phase = SempRunPhase.ERROR, failure = null) }
        }
        val steps = guarded { loadSteps(runId, messageId) }
        currentCoroutineContext().ensureActive()
        update {
            when (steps) {
                is RepositoryResult.Content -> it.copy(
                    stepsPhase = SempStepsPhase.READY,
                    steps = steps.value.steps.map { step -> step.toRow() },
                    historyTruncated = steps.value.truncatedHistory,
                )
                else -> it.copy(stepsPhase = SempStepsPhase.ERROR)
            }
        }
        return (run as? RepositoryResult.Content)?.value
    }

    private fun retry() {
        if (state.value.retrying || state.value.run?.canRetry != true) return
        update { it.copy(retrying = true, retryFailed = false) }
        viewModelScope.launch {
            val result = guarded { retryRun(runId) }
            currentCoroutineContext().ensureActive()
            update { it.copy(retrying = false, retryFailed = result !is RepositoryResult.Content) }
            if (result is RepositoryResult.Content) load(initial = false)
        }
    }
}

private fun SempRun.toView() = SempRunView(
    id = id,
    title = title,
    display = when (status) {
        SempRunStatus.RUNNING -> SempRunDisplay.RUNNING
        SempRunStatus.DONE -> SempRunDisplay.DONE
        SempRunStatus.WAITING_APPROVAL -> SempRunDisplay.WAITING_APPROVAL
        SempRunStatus.ERROR -> SempRunDisplay.ERROR
    },
    trigger = when (trigger) {
        SempRunTrigger.USER -> SempRunTriggerKind.USER
        SempRunTrigger.TICK -> SempRunTriggerKind.TICK
        SempRunTrigger.MCP -> SempRunTriggerKind.MCP
        SempRunTrigger.SUPERVISOR -> SempRunTriggerKind.SUPERVISOR
    },
    threadId = threadId,
    projectName = projectName,
    startedAt = startedAt,
    durationMs = durationMs,
    approvalCount = approvalCount,
    pendingApprovalCount = pendingApprovalCount,
    errorSummary = errorSummary,
    canRetry = trigger == SempRunTrigger.TICK && status == SempRunStatus.ERROR && retriedByRunId == null,
    totalCostUsd = totalCostUsd,
    costIsEstimate = costIsEstimate,
    usage = usage.map { SempUsageRow(it.modelName, it.calls, it.inputTokens, it.outputTokens, it.costUsd) },
)

private fun SempRunStep.toRow() = SempRunStepRow(
    id = id,
    kind = when (kind) {
        SempRunStepKind.START -> SempRunStepKindView.START
        SempRunStepKind.PLAN -> SempRunStepKindView.PLAN
        SempRunStepKind.TOOL -> SempRunStepKindView.TOOL
        SempRunStepKind.APPROVAL -> SempRunStepKindView.APPROVAL
        SempRunStepKind.ANSWER -> SempRunStepKindView.ANSWER
        SempRunStepKind.END -> SempRunStepKindView.END
        SempRunStepKind.ERROR -> SempRunStepKindView.ERROR
    },
    state = when (state) {
        SempRunStepState.RUNNING -> SempLineState.RUNNING
        SempRunStepState.OK -> SempLineState.OK
        SempRunStepState.ERROR -> SempLineState.ERROR
        SempRunStepState.WAITING_APPROVAL -> SempLineState.WAITING_APPROVAL
    },
    title = title,
    summary = summary ?: targetName,
    at = at,
    durationMs = durationMs,
)
