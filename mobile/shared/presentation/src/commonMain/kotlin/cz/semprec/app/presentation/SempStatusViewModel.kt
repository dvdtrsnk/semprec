package cz.semprec.app.presentation

import androidx.lifecycle.viewModelScope
import cz.semprec.app.core.FailureKind
import cz.semprec.app.domain.EditSempProjectAgent
import cz.semprec.app.domain.LoadSempStatus
import cz.semprec.app.domain.RepositoryResult
import cz.semprec.app.domain.RetrySempReply
import cz.semprec.app.domain.RetrySempRun
import cz.semprec.app.domain.SempProblem
import cz.semprec.app.domain.SempProblemAction
import cz.semprec.app.domain.SempProblemSeverity
import cz.semprec.app.domain.SempStatusReport
import kotlinx.coroutines.Job
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.launch

enum class SempStatusPhase { LOADING, READY, ERROR }

/** What a problem can be fixed with, from the problem's own button. */
enum class SempIssueFix { RETRY, DISABLE_AUTOMATION }

/** Where the link of a problem leads. */
enum class SempIssueLink { CHAT, THREAD, PROJECT }

/** A problem that needs attention. [title] and [text] are the server's, in the person's language. */
data class SempIssue(
    val id: String,
    val category: String,
    val critical: Boolean,
    val title: String,
    val text: String,
    val since: String?,
    val mergedCount: Int,
    val projectName: String?,
    val fix: SempIssueFix?,
    val link: SempIssueLink?,
    val busy: Boolean,
    val fixFailed: Boolean,
)

/** One service of Semp; [failingSince] is set while it has a problem. */
data class SempServiceRow(val key: String, val name: String, val failingSince: String?, val lastActivityAt: String?)

data class SempResolvedRow(val id: String, val title: String, val resolvedAt: String)

data class SempStatusState(
    val phase: SempStatusPhase = SempStatusPhase.LOADING,
    val failure: FailureKind? = null,
    val issues: List<SempIssue> = emptyList(),
    val services: List<SempServiceRow> = emptyList(),
    val resolved: List<SempResolvedRow> = emptyList(),
    val historyOpen: Boolean = false,
)

sealed interface SempStatusAction {
    data object Retry : SempStatusAction

    data class Fix(val issueId: String) : SempStatusAction

    data class Open(val issueId: String) : SempStatusAction

    data object ToggleHistory : SempStatusAction
}

sealed interface SempStatusEffect {
    data class OpenChat(val threadId: String, val messageId: String) : SempStatusEffect

    data class OpenThread(val threadId: String) : SempStatusEffect

    data class OpenProject(val projectId: String) : SempStatusEffect
}

/** What the status screen does about a problem. */
internal class SempStatusFixes(
    val retryRun: RetrySempRun,
    val retryReply: RetrySempReply,
    val agent: EditSempProjectAgent
)

/**
 * The health of Semp: the problems that need attention with the one thing that can fix each, the services, and the
 * problems solved in the last days.
 */
class SempStatusViewModel internal constructor(
    private val load: LoadSempStatus,
    private val fixes: SempStatusFixes,
) : ScreenViewModel<SempStatusState, SempStatusAction, SempStatusEffect>(SempStatusState()) {
    private var loadJob: Job? = null
    private var report: SempStatusReport? = null
    private val busy = mutableSetOf<String>()
    private val failed = mutableSetOf<String>()

    init {
        read(silent = false)
    }

    override fun onAction(action: SempStatusAction) {
        if (isClosed) return
        when (action) {
            SempStatusAction.Retry -> read(silent = false)
            is SempStatusAction.Fix -> fix(action.issueId)
            is SempStatusAction.Open -> open(action.issueId)
            SempStatusAction.ToggleHistory -> update { it.copy(historyOpen = !it.historyOpen) }
        }
    }

    private fun read(silent: Boolean) {
        loadJob?.cancel()
        if (!silent) update { it.copy(phase = SempStatusPhase.LOADING, failure = null) }
        loadJob = viewModelScope.launch {
            val result = guarded { load() }
            currentCoroutineContext().ensureActive()
            when (result) {
                is RepositoryResult.Content -> {
                    report = result.value
                    publish()
                }
                is RepositoryResult.Failure -> update { it.copy(phase = SempStatusPhase.ERROR, failure = result.kind) }
                null -> update { it.copy(phase = SempStatusPhase.ERROR, failure = null) }
            }
        }
    }

    private fun publish() {
        val current = report ?: return
        update {
            it.copy(
                phase = SempStatusPhase.READY,
                failure = null,
                issues = current.problems.map { problem -> problem.toIssue() },
                services = current.services.map { SempServiceRow(it.key, it.name, it.failingSince, it.lastActivityAt) },
                resolved = current.resolved.map { r -> SempResolvedRow(r.id, r.title, r.resolvedAt) },
            )
        }
    }

    private fun problem(id: String): SempProblem? = report?.problems?.firstOrNull { it.id == id }

    private fun fix(issueId: String) {
        val action = problem(issueId)?.actions?.firstOrNull { it.fixKind() != null } ?: return
        if (!busy.add(issueId)) return
        failed.remove(issueId)
        publish()
        viewModelScope.launch {
            val result = guarded { carryOut(action) }
            currentCoroutineContext().ensureActive()
            busy.remove(issueId)
            if (result is RepositoryResult.Content) {
                read(silent = true)
            } else {
                failed.add(issueId)
                publish()
            }
        }
    }

    private suspend fun carryOut(action: SempProblemAction): RepositoryResult<Unit> = when (action) {
        is SempProblemAction.RetryRun -> fixes.retryRun(action.runId)
        is SempProblemAction.RetryPrompt -> fixes.retryReply(action.threadId, action.messageId)
        is SempProblemAction.DisableHeartbeat -> fixes.agent.setTaskEnabled(action.heartbeatId, false)
        is SempProblemAction.OpenChat, is SempProblemAction.OpenThread, is SempProblemAction.OpenProject ->
            RepositoryResult.Failure(FailureKind.REJECTED)
    }

    private fun open(issueId: String) {
        val effect = problem(issueId)?.actions?.firstNotNullOfOrNull { action ->
            when (action) {
                is SempProblemAction.OpenChat -> SempStatusEffect.OpenChat(action.threadId, action.messageId)
                is SempProblemAction.OpenThread -> SempStatusEffect.OpenThread(action.threadId)
                is SempProblemAction.OpenProject -> SempStatusEffect.OpenProject(action.projectId)
                else -> null
            }
        } ?: return
        emit(effect)
    }

    private fun SempProblem.toIssue() = SempIssue(
        id = id,
        category = category,
        critical = severity == SempProblemSeverity.CRITICAL,
        title = title,
        text = text,
        since = since,
        mergedCount = mergedCount,
        projectName = projectName,
        fix = actions.firstNotNullOfOrNull { it.fixKind() },
        link = actions.firstNotNullOfOrNull { it.linkKind() },
        busy = id in busy,
        fixFailed = id in failed,
    )
}

private fun SempProblemAction.fixKind(): SempIssueFix? = when (this) {
    is SempProblemAction.RetryRun, is SempProblemAction.RetryPrompt -> SempIssueFix.RETRY
    is SempProblemAction.DisableHeartbeat -> SempIssueFix.DISABLE_AUTOMATION
    is SempProblemAction.OpenChat, is SempProblemAction.OpenThread, is SempProblemAction.OpenProject -> null
}

private fun SempProblemAction.linkKind(): SempIssueLink? = when (this) {
    is SempProblemAction.OpenChat -> SempIssueLink.CHAT
    is SempProblemAction.OpenThread -> SempIssueLink.THREAD
    is SempProblemAction.OpenProject -> SempIssueLink.PROJECT
    is SempProblemAction.RetryRun, is SempProblemAction.RetryPrompt, is SempProblemAction.DisableHeartbeat -> null
}
