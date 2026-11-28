package cz.alldots.app.presentation

import androidx.lifecycle.viewModelScope
import cz.alldots.app.domain.EditSempProjectAgent
import cz.alldots.app.domain.ListSempProjectRuns
import cz.alldots.app.domain.LoadSempProjectAgent
import cz.alldots.app.domain.RepositoryResult
import cz.alldots.app.domain.SempDriftChoice
import cz.alldots.app.domain.SempDriftFinding
import cz.alldots.app.domain.SempGuidance
import cz.alldots.app.domain.SempGuidanceDocument
import cz.alldots.app.domain.SempGuidanceSave
import kotlinx.coroutines.Job
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.launch

/** What the page of a project's agent reads and writes. */
internal class SempProjectAgentCases(
    val load: LoadSempProjectAgent,
    val edit: EditSempProjectAgent,
    val runs: ListSempProjectRuns,
)

/**
 * The agent of one project: its instructions (saved as the person leaves a part, against the version they were read
 * at), what Semp does that the instructions do not agree with, the tools it may use, its automatic tasks and its
 * latest runs. A switch is shown at once and put back when the server refuses it.
 */
class SempProjectAgentViewModel internal constructor(
    private val projectId: String,
    private val cases: SempProjectAgentCases,
) : ScreenViewModel<SempProjectAgentState, SempProjectAgentAction, SempProjectAgentEffect>(SempProjectAgentState()) {
    private var loadJob: Job? = null
    private var saveJob: Job? = null
    private var document: SempGuidanceDocument? = null
    private var unsaved: SempGuidance? = null
    private var finding: SempDriftFinding? = null

    init {
        load()
    }

    override fun onAction(action: SempProjectAgentAction) {
        if (isClosed) return
        when (action) {
            SempProjectAgentAction.Retry -> load()
            is SempProjectAgentAction.SaveSection -> save(action.section, action.text)
            SempProjectAgentAction.RetrySave -> startSaving()
            is SempProjectAgentAction.ResolveDrift -> resolve(action.answer)
            is SempProjectAgentAction.SetTool -> setTool(action.registrationId, action.granted)
            is SempProjectAgentAction.SetTask -> setTask(action.taskId, action.enabled)
            is SempProjectAgentAction.OpenTask ->
                state.value.tasks.firstOrNull { it.id == action.taskId }?.threadId
                    ?.let { emit(SempProjectAgentEffect.OpenThread(it)) }
            is SempProjectAgentAction.OpenRun ->
                state.value.runs.firstOrNull { it.id == action.rowId }
                    ?.let { emit(SempProjectAgentEffect.OpenRun(it.runId, it.messageId)) }
            SempProjectAgentAction.DismissFailure -> update { it.copy(changeFailed = false) }
        }
    }

    private fun load() {
        loadJob?.cancel()
        update { SempProjectAgentState() }
        loadJob = viewModelScope.launch {
            val guidance = guarded { cases.load.guidance(projectId) }
            val name = guarded { cases.load.projectName(projectId) }
            val drift = guarded { cases.load.drift(projectId) }
            val grants = guarded { cases.load.grants(projectId) }
            val tasks = guarded { cases.load.tasks(projectId) }
            val runs = guarded { cases.runs(projectId) }
            currentCoroutineContext().ensureActive()
            if (guidance !is RepositoryResult.Content) {
                val kind = (guidance as? RepositoryResult.Failure)?.kind
                update { it.copy(phase = SempAgentPhase.ERROR, failure = kind) }
                return@launch
            }
            document = guidance.value
            finding = (drift as? RepositoryResult.Content)?.value?.findings?.firstOrNull()
            val optional = listOf(drift, grants, tasks, runs)
            update {
                it.copy(
                    phase = SempAgentPhase.READY,
                    projectName = (name as? RepositoryResult.Content)?.value,
                    sections = guidance.value.guidance.toSections(),
                    finding = finding?.toFinding(),
                    servers = (grants as? RepositoryResult.Content)?.value.orEmpty().toServers(),
                    tasks = (tasks as? RepositoryResult.Content)?.value.orEmpty().map { task -> task.toRow() },
                    runs = (runs as? RepositoryResult.Content)?.value.orEmpty().map { run -> run.toRow() },
                    partialFailure = optional.any { result -> result !is RepositoryResult.Content },
                )
            }
        }
    }

    private fun save(section: SempSection, text: String) {
        val base = unsaved ?: document?.guidance ?: return
        val changed = base.with(section, text)
        if (changed == base) return
        unsaved = changed
        startSaving()
    }

    private fun startSaving() {
        if (unsaved == null || saveJob?.isActive == true) return
        update { it.copy(saveState = SempSaveState.SAVING) }
        saveJob = viewModelScope.launch {
            var pending = unsaved
            while (pending != null) {
                val sending: SempGuidance = pending
                val result = guarded { cases.edit.saveGuidance(projectId, sending, document?.updatedAt) }
                currentCoroutineContext().ensureActive()
                pending = if (settle(sending, result)) unsaved else null
            }
        }
    }

    /** Takes the answer of a save; `false` when saving has to stop. */
    private fun settle(sent: SempGuidance, result: RepositoryResult<SempGuidanceSave>?): Boolean {
        val content = (result as? RepositoryResult.Content)?.value
        when (content) {
            is SempGuidanceSave.Saved -> {
                document = content.document
                if (unsaved == sent) unsaved = null
                update { it.copy(saveState = if (unsaved == null) SempSaveState.SAVED else SempSaveState.SAVING) }
            }
            is SempGuidanceSave.Conflict -> {
                document = content.current
                unsaved = null
                update { it.copy(saveState = SempSaveState.CONFLICT, sections = content.current.guidance.toSections()) }
            }
            null -> update { it.copy(saveState = SempSaveState.FAILED) }
        }
        return content is SempGuidanceSave.Saved && unsaved != null
    }

    private fun resolve(answer: SempDriftAnswer) {
        val current = finding ?: return
        val choice = when (answer) {
            SempDriftAnswer.ALLOW -> SempDriftChoice.ALLOW
            SempDriftAnswer.FORBID -> SempDriftChoice.FORBID
            SempDriftAnswer.DISMISS -> SempDriftChoice.DISMISS
        }
        update { it.copy(saveState = SempSaveState.SAVING) }
        viewModelScope.launch {
            val result = guarded { cases.edit.resolveDrift(projectId, current, choice, document?.updatedAt) }
            currentCoroutineContext().ensureActive()
            val content = (result as? RepositoryResult.Content)?.value
            if (content == null) {
                update { it.copy(saveState = SempSaveState.FAILED) }
                return@launch
            }
            val taken = content.document()
            document = taken
            if (content is SempGuidanceSave.Saved) finding = null
            update {
                it.copy(
                    saveState = if (content is SempGuidanceSave.Saved) SempSaveState.SAVED else SempSaveState.CONFLICT,
                    sections = taken.guidance.toSections(),
                    finding = finding?.toFinding(),
                )
            }
        }
    }

    private fun setTool(registrationId: String, granted: Boolean) {
        update { it.copy(servers = it.servers.withTool(registrationId, granted)) }
        viewModelScope.launch {
            val result = guarded { cases.edit.setGrant(projectId, registrationId, granted) }
            currentCoroutineContext().ensureActive()
            if (result !is RepositoryResult.Content) {
                update { it.copy(servers = it.servers.withTool(registrationId, !granted), changeFailed = true) }
            }
        }
    }

    private fun setTask(taskId: String, enabled: Boolean) {
        update {
            it.copy(tasks = it.tasks.map { task -> if (task.id == taskId) task.copy(enabled = enabled) else task })
        }
        viewModelScope.launch {
            val result = guarded { cases.edit.setTaskEnabled(taskId, enabled) }
            currentCoroutineContext().ensureActive()
            if (result !is RepositoryResult.Content) {
                update {
                    it.copy(
                        tasks = it.tasks.map { task -> if (task.id == taskId) task.copy(enabled = !enabled) else task },
                        changeFailed = true,
                    )
                }
            }
        }
    }
}

private fun SempGuidanceSave.document(): SempGuidanceDocument = when (this) {
    is SempGuidanceSave.Saved -> document
    is SempGuidanceSave.Conflict -> current
}
