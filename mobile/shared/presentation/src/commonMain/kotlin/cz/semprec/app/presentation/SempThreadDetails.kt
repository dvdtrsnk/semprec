package cz.semprec.app.presentation

import cz.semprec.app.domain.LoadSempRunSteps
import cz.semprec.app.domain.RepositoryResult
import kotlinx.coroutines.Job
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.launch

/** What a person opens inside the conversation: the steps of a reply, and the decision on an approval request. */
internal class SempThreadDetails(
    private val store: SempThreadStore,
    private val loader: SempThreadLoader,
    private val steps: LoadSempRunSteps,
    private val approvalFlow: SempApprovalFlow,
) {
    private val decisions = mutableMapOf<String, Job>()

    /** Opens the steps of the reply [messageId], reading them from the server, or closes them again. */
    fun toggleRun(messageId: String) {
        val runId = store.data.messages.firstOrNull { it.id == messageId }?.agentRunId ?: return
        if (store.data.opened.containsKey(messageId)) {
            store.change { copy(opened = opened - messageId) }
            return
        }
        store.change { copy(opened = opened + (messageId to SempOpenedRun(SempStepsPhase.LOADING, emptyList()))) }
        store.scope.launch {
            val result = guarded { steps(runId, messageId) }
            currentCoroutineContext().ensureActive()
            val loaded = when (result) {
                is RepositoryResult.Content -> SempOpenedRun(SempStepsPhase.READY, result.value.steps)
                else -> SempOpenedRun(SempStepsPhase.ERROR, emptyList())
            }
            store.change { if (opened.containsKey(messageId)) copy(opened = opened + (messageId to loaded)) else this }
        }
    }

    /** Decides the request [approvalId] and shows how it goes, from "deciding" to carried out. */
    fun decide(approvalId: String, approve: Boolean) {
        if (store.data.approvals[approvalId] == null || decisions[approvalId]?.isActive == true) return
        decisions[approvalId] = store.scope.launch {
            approvalFlow.run(approvalId, approve) { update ->
                store.change {
                    val changed = approvals[approvalId]?.after(update) ?: return@change this
                    copy(approvals = approvals + (approvalId to changed))
                }
            }
            store.data.threadId?.let { loader.reload(it) }
        }
    }
}
