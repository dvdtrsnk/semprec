package cz.semprec.app.presentation

import androidx.lifecycle.viewModelScope
import cz.semprec.app.core.ItemKind
import cz.semprec.app.core.MeetingTaskStatus
import cz.semprec.app.domain.ItemRepository
import cz.semprec.app.domain.MeetingRepository
import cz.semprec.app.domain.MeetingSuggestion
import cz.semprec.app.domain.MeetingTask
import cz.semprec.app.domain.RecordingEntry
import cz.semprec.app.domain.RecordingsRepository
import cz.semprec.app.domain.RepositoryResult
import cz.semprec.app.domain.TranscriptRepository
import cz.semprec.app.domain.WorkItem
import cz.semprec.app.domain.map
import cz.semprec.app.domain.then
import kotlinx.coroutines.Job
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.emptyFlow
import kotlinx.coroutines.launch

/** What the page of an event reads in one go. */
private class MeetingData(
    val event: WorkItem,
    val tasks: List<MeetingTask>,
    val suggestions: List<MeetingSuggestion>,
    val recordings: List<RecordingEntry>,
)

/**
 * The page of the event [eventId]. A change is a request and the page is read again after it, so what is shown is
 * what the server holds. While a recording of the event is being processed the page reads again on its own. A newer
 * read supersedes the one before it.
 */
class MeetingViewModel internal constructor(
    private val eventId: String,
    private val details: ItemRepository,
    private val meetings: MeetingRepository,
    private val recordings: RecordingsRepository,
    private val transcripts: TranscriptRepository,
    changes: Flow<Unit> = emptyFlow(),
) : ScreenViewModel<MeetingState, MeetingAction, MeetingEffect>(MeetingState()) {
    private var loadJob: Job? = null
    private var pollJob: Job? = null

    init {
        reloadOnChanges(changes) { onAction(MeetingAction.Refresh) }
        read(showWait = true)
    }

    override fun onAction(action: MeetingAction) {
        if (isClosed) return
        when (action) {
            MeetingAction.Retry -> read(showWait = true)
            MeetingAction.Refresh -> read(showWait = state.value.phase != MeetingPhase.CONTENT)
            is MeetingAction.ToggleTask -> toggle(action.taskId)
            is MeetingAction.AddTask -> addTask(action.title.trim())
            is MeetingAction.AddSuggestion -> addSuggestion(action)
            is MeetingAction.OpenTask -> emit(MeetingEffect.ShowTask(action.taskId))
            is MeetingAction.OpenRecording -> emit(MeetingEffect.ShowRecording(action.recordingId))
            MeetingAction.OpenNotes -> emit(MeetingEffect.ShowNotes(eventId))
            MeetingAction.OpenDetails -> emit(MeetingEffect.ShowDetails(eventId))
            MeetingAction.DismissFailure -> update { it.copy(writeFailure = null) }
        }
    }

    private fun toggle(taskId: String) {
        val task = state.value.tasks.firstOrNull { it.id == taskId } ?: return
        val done = when (task.status) {
            MeetingTaskStatus.OPEN, MeetingTaskStatus.MISSED -> true
            MeetingTaskStatus.DONE -> false
            MeetingTaskStatus.DONE_ELSEWHERE, MeetingTaskStatus.MOVED -> return
        }
        change(busyTask = taskId) { meetings.setDone(taskId, done) }
    }

    private fun addTask(title: String) {
        if (title.isEmpty()) return
        change { meetings.addTask(eventId, title) }
    }

    private fun addSuggestion(action: MeetingAction.AddSuggestion) {
        val known = state.value.suggestions.any {
            it.transcriptId == action.transcriptId && it.actionItemId == action.actionItemId
        }
        if (!known) return
        change(busySuggestion = action.transcriptId to action.actionItemId) {
            transcripts.addTask(action.transcriptId, action.actionItemId)
        }
    }

    private fun read(showWait: Boolean) {
        loadJob?.cancel()
        pollJob?.cancel()
        update { if (showWait) MeetingState() else it }
        loadJob = viewModelScope.launch {
            val result = answer { load() }
            ensureActive()
            update {
                when (result) {
                    is Answer.Done -> result.value.toState(it)
                    is Answer.Rejected ->
                        if (it.phase == MeetingPhase.CONTENT) it else MeetingState(MeetingPhase.ERROR, result.kind)
                }
            }
            if (state.value.recordings.any { it.processing }) schedulePoll()
        }
    }

    private fun schedulePoll() {
        pollJob = viewModelScope.launch {
            delay(RECORDINGS_POLL_MILLIS)
            read(showWait = false)
        }
    }

    /** The event, its tasks, the suggestions and the recordings, asked together; the first failure is the answer. */
    private suspend fun load(): RepositoryResult<MeetingData> = coroutineScope {
        val event = async { details.load(ItemKind.EVENT, eventId) }
        val tasks = async { meetings.tasks(eventId) }
        val suggestions = async { meetings.suggestions(eventId) }
        val recorded = async { recordings.list(eventId) }
        combine(event.await(), tasks.await(), suggestions.await(), recorded.await())
    }

    /** Runs a change, then reads the page again; one that fails leaves the page as it was and says why. */
    private fun change(
        busyTask: String? = null,
        busySuggestion: Pair<String, Int>? = null,
        call: suspend () -> RepositoryResult<Unit>,
    ) {
        if (state.value.working || state.value.phase != MeetingPhase.CONTENT) return
        update { current ->
            current.copy(
                working = true,
                writeFailure = null,
                tasks = current.tasks.map { if (it.id == busyTask) it.copy(busy = true) else it },
                suggestions = current.suggestions.map {
                    if (busySuggestion == it.transcriptId to it.actionItemId) it.copy(busy = true) else it
                },
            )
        }
        loadJob?.cancel()
        pollJob?.cancel()
        loadJob = viewModelScope.launch {
            val result = answer { call() }
            ensureActive()
            val fresh = if (result is Answer.Done) answer { load() } else null
            ensureActive()
            update { current ->
                val idle = current.copy(
                    working = false,
                    tasks = current.tasks.map { it.copy(busy = false) },
                    suggestions = current.suggestions.map { it.copy(busy = false) },
                )
                when {
                    result is Answer.Rejected -> idle.copy(writeFailure = Failed(result.kind))
                    fresh is Answer.Done -> fresh.value.toState(idle)
                    fresh is Answer.Rejected -> idle.copy(writeFailure = Failed(fresh.kind))
                    else -> idle
                }
            }
            if (state.value.recordings.any { it.processing }) schedulePoll()
        }
    }
}

private fun combine(
    event: RepositoryResult<WorkItem>,
    tasks: RepositoryResult<List<MeetingTask>>,
    suggestions: RepositoryResult<List<MeetingSuggestion>>,
    recordings: RepositoryResult<List<RecordingEntry>>,
): RepositoryResult<MeetingData> = event.then { found ->
    tasks.then { hosted ->
        suggestions.then { offered ->
            recordings.map { recorded -> MeetingData(found, hosted, offered, recorded) }
        }
    }
}

private fun MeetingData.toState(current: MeetingState): MeetingState = current.copy(
    phase = MeetingPhase.CONTENT,
    failure = null,
    title = event.title,
    place = event.place,
    date = event.schedule.date,
    endDate = event.schedule.endDate,
    timeFrom = event.schedule.timeFrom,
    timeTo = event.schedule.timeTo,
    projectName = event.project?.title,
    projectColor = event.project?.color,
    companyName = event.company?.title,
    people = event.people.map { MeetingPersonRow(it.id, it.title) },
    tasks = tasks.map { MeetingTaskRow(it.id, it.title, it.status, it.detail, busy = false) },
    suggestions = suggestions.map {
        MeetingSuggestionRow(it.transcriptId, it.actionItemId, it.text, it.ownerLabel, it.due, busy = false)
    },
    recordings = recordings.map { it.toRow() },
)
