package cz.alldots.app.presentation

import cz.alldots.app.core.CapturedAudio
import cz.alldots.app.core.EntityRef
import cz.alldots.app.core.FailureKind
import cz.alldots.app.core.ItemKind
import cz.alldots.app.core.MeetingTaskStatus
import cz.alldots.app.core.PlaybackSource
import cz.alldots.app.core.ProjectRef
import cz.alldots.app.core.RecordingPairing
import cz.alldots.app.core.RecordingStatus
import cz.alldots.app.domain.ItemChange
import cz.alldots.app.domain.ItemRepository
import cz.alldots.app.domain.MeetingRepository
import cz.alldots.app.domain.MeetingSuggestion
import cz.alldots.app.domain.MeetingTask
import cz.alldots.app.domain.RecordingEntry
import cz.alldots.app.domain.RecordingsRepository
import cz.alldots.app.domain.RepositoryResult
import cz.alldots.app.domain.Schedule
import cz.alldots.app.domain.TranscriptCandidate
import cz.alldots.app.domain.TranscriptDetail
import cz.alldots.app.domain.TranscriptRepository
import cz.alldots.app.domain.WorkItem
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

private val EVENT = WorkItem(
    kind = ItemKind.EVENT,
    id = "ev-1",
    version = "v1",
    title = "Client meeting",
    schedule = Schedule("2026-10-16", "10:00", "11:30"),
    place = "Office",
    project = ProjectRef("pr-1", "Web", "#FF9500"),
    people = listOf(EntityRef("p1", "Petr")),
    company = EntityRef("c1", "Novak Web"),
)

private val TASKS = listOf(
    MeetingTask("t1", "Send the offer", MeetingTaskStatus.OPEN, null),
    MeetingTask("t2", "Call the client", MeetingTaskStatus.DONE, null),
    MeetingTask("t3", "Pay the invoice", MeetingTaskStatus.MOVED, "Standup"),
    MeetingTask("t4", "Missed one", MeetingTaskStatus.MISSED, null),
)

private val UNREADABLE = FailureKind.UNAVAILABLE

private val SUGGESTIONS = listOf(MeetingSuggestion("tr-1", 0, "Prepare wireframes", "Jana", "2026-10-30"))

private fun recording(status: RecordingStatus = RecordingStatus.DONE) =
    RecordingEntry(
        "tr-1", "Client meeting", "2026-10-16T10:02:00+02:00", 4867, status, RecordingPairing.EVENT, "ev-1",
        "Client meeting", null,
    )

private class ScriptedMeeting(
    tasks: List<ScriptedStep<List<MeetingTask>>> = listOf({ RepositoryResult.Content(TASKS) }),
    var write: ScriptedStep<Unit> = { RepositoryResult.Content(Unit) },
) : MeetingRepository {
    val taskCalls = CallScript(tasks)
    val writes = mutableListOf<String>()

    override suspend fun tasks(eventId: String) = taskCalls.next()

    override suspend fun suggestions(eventId: String): RepositoryResult<List<MeetingSuggestion>> =
        RepositoryResult.Content(SUGGESTIONS)

    override suspend fun addTask(eventId: String, title: String): RepositoryResult<Unit> {
        writes += "add:$eventId:$title"
        return write()
    }

    override suspend fun setDone(taskId: String, done: Boolean): RepositoryResult<Unit> {
        writes += "done:$taskId:$done"
        return write()
    }
}

private class ScriptedEvents(private val loads: CallScript<WorkItem>) : ItemRepository {
    override suspend fun load(kind: ItemKind, id: String) = loads.next()

    override suspend fun update(item: WorkItem, change: ItemChange): RepositoryResult<WorkItem> =
        error("the page never edits the event itself")

    override suspend fun delete(kind: ItemKind, id: String): RepositoryResult<Unit> =
        error("the page never deletes the event itself")
}

private class ScriptedEventRecordings(private val lists: CallScript<List<RecordingEntry>>) : RecordingsRepository {
    override suspend fun list(eventId: String?) = lists.next()

    override suspend fun upload(audio: CapturedAudio, eventId: String?): RepositoryResult<Unit> =
        error("the page never uploads")
}

private class SuggestionTasks : TranscriptRepository {
    val writes = mutableListOf<String>()

    override suspend fun detail(transcriptId: String): RepositoryResult<TranscriptDetail> = error("not read")

    override suspend fun candidates(transcriptId: String): RepositoryResult<List<TranscriptCandidate>> =
        error("not read")

    override suspend fun assignSpeaker(transcriptId: String, speaker: String, personId: String?) = error("not used")

    override suspend fun note(transcriptId: String, actionItemId: Int, noted: Boolean) = error("not used")

    override suspend fun addTask(transcriptId: String, actionItemId: Int): RepositoryResult<Unit> {
        writes += "task:$transcriptId:$actionItemId"
        return RepositoryResult.Content(Unit)
    }

    override suspend fun removeTask(transcriptId: String, actionItemId: Int) = error("not used")

    override suspend fun playback(blobId: String): RepositoryResult<PlaybackSource> = error("not used")
}

@OptIn(ExperimentalCoroutinesApi::class)
class MeetingViewModelTest : MainDispatcherTest() {
    private class Setup(
        val meeting: ScriptedMeeting,
        val events: CallScript<WorkItem>,
        val recordings: CallScript<List<RecordingEntry>>,
        val tasks: SuggestionTasks,
        val vm: MeetingViewModel,
    )

    private fun setup(
        meeting: ScriptedMeeting = ScriptedMeeting(),
        events: List<ScriptedStep<WorkItem>> = listOf({ RepositoryResult.Content(EVENT) }),
        recordings: List<ScriptedStep<List<RecordingEntry>>> =
            listOf({ RepositoryResult.Content(listOf(recording())) }),
    ): Setup {
        val eventCalls = CallScript(events)
        val recordingCalls = CallScript(recordings)
        val tasks = SuggestionTasks()
        val vm =
            MeetingViewModel(
                "ev-1", ScriptedEvents(eventCalls), meeting, ScriptedEventRecordings(recordingCalls), tasks,
            )
        return Setup(meeting, eventCalls, recordingCalls, tasks, vm)
    }

    @Test fun `loads the event with its tasks suggestions recordings people and context`() = runTest(dispatcher) {
        val s = setup()
        assertEquals(MeetingState(), s.vm.state.value)
        runCurrent()
        val state = s.vm.state.value
        assertEquals(MeetingPhase.CONTENT, state.phase)
        assertEquals("Client meeting", state.title)
        assertEquals("Office", state.place)
        assertEquals("2026-10-16", state.date)
        assertEquals("10:00", state.timeFrom)
        assertEquals("11:30", state.timeTo)
        assertEquals("Web", state.projectName)
        assertEquals("#FF9500", state.projectColor)
        assertEquals("Novak Web", state.companyName)
        assertEquals(listOf(MeetingPersonRow("p1", "Petr")), state.people)
        assertEquals(listOf("t1", "t2", "t3", "t4"), state.tasks.map { it.id })
        assertEquals("Standup", state.tasks[2].detail)
        assertEquals(listOf("Prepare wireframes"), state.suggestions.map { it.text })
        assertEquals(listOf("tr-1"), state.recordings.map { it.id })
        s.vm.close()
    }

    @Test fun `any part that cannot be read makes the page an error and retry reads it all again`() =
        runTest(dispatcher) {
            val s = setup(
                meeting = ScriptedMeeting(
                    tasks = listOf(
                        { RepositoryResult.Failure(FailureKind.UNAVAILABLE) },
                        { RepositoryResult.Content(TASKS) },
                    ),
                ),
            )
            runCurrent()
            assertEquals(MeetingState(MeetingPhase.ERROR, FailureKind.UNAVAILABLE), s.vm.state.value)
            s.vm.onAction(MeetingAction.Retry)
            assertEquals(MeetingPhase.LOADING, s.vm.state.value.phase)
            runCurrent()
            assertEquals(MeetingPhase.CONTENT, s.vm.state.value.phase)
            s.vm.close()
        }

    @Test fun `an event that is gone is not found and an unexpected exception has no kind`() = runTest(dispatcher) {
        val gone = setup(events = listOf({ RepositoryResult.Failure(FailureKind.NOT_FOUND) }))
        val broken = setup(recordings = listOf(crashes()))
        runCurrent()
        assertEquals(MeetingState(MeetingPhase.ERROR, FailureKind.NOT_FOUND), gone.vm.state.value)
        assertEquals(MeetingState(MeetingPhase.ERROR, null), broken.vm.state.value)
        gone.vm.close()
        broken.vm.close()
    }

    @Test fun `a refresh keeps the page and a failed one leaves it as it was`() = runTest(dispatcher) {
        val s =
            setup(events = listOf({ RepositoryResult.Content(EVENT) }, { RepositoryResult.Failure(UNREADABLE) }))
        runCurrent()
        val loaded = s.vm.state.value
        s.vm.onAction(MeetingAction.Refresh)
        assertEquals(loaded, s.vm.state.value)
        runCurrent()
        assertEquals(loaded, s.vm.state.value)
        s.vm.close()
    }

    @Test fun `a refresh before the page loaded is a retry and a late answer of a superseded read is dropped`() =
        runTest(dispatcher) {
            val gate = CompletableDeferred<Unit>()
            val s = setup(
                events = listOf(
                    answersLate(gate, RepositoryResult.Content(EVENT.copy(title = "Stale"))),
                    { RepositoryResult.Content(EVENT) },
                ),
            )
            runCurrent()
            s.vm.onAction(MeetingAction.Refresh)
            runCurrent()
            gate.complete(Unit)
            runCurrent()
            assertEquals("Client meeting", s.vm.state.value.title)
            s.vm.close()
        }

    @Test fun `ticking a task finishes it and ticking a finished one opens it again`() = runTest(dispatcher) {
        val s = setup()
        runCurrent()
        s.vm.onAction(MeetingAction.ToggleTask("t1"))
        assertTrue(s.vm.state.value.tasks.first { it.id == "t1" }.busy)
        assertTrue(s.vm.state.value.working)
        runCurrent()
        s.vm.onAction(MeetingAction.ToggleTask("t2"))
        runCurrent()
        s.vm.onAction(MeetingAction.ToggleTask("t4"))
        runCurrent()
        assertEquals(listOf("done:t1:true", "done:t2:false", "done:t4:true"), s.meeting.writes)
        assertTrue(s.vm.state.value.tasks.none { it.busy })
        assertEquals(false, s.vm.state.value.working)
        s.vm.close()
    }

    @Test fun `a task that went to another event or is unknown cannot be ticked`() = runTest(dispatcher) {
        val s = setup()
        runCurrent()
        s.vm.onAction(MeetingAction.ToggleTask("t3"))
        s.vm.onAction(MeetingAction.ToggleTask("nobody"))
        runCurrent()
        assertEquals(emptyList(), s.meeting.writes)
        s.vm.close()
    }

    @Test fun `a new task is trimmed and a blank one makes nothing`() = runTest(dispatcher) {
        val s = setup()
        runCurrent()
        s.vm.onAction(MeetingAction.AddTask("   "))
        s.vm.onAction(MeetingAction.AddTask("  Book room  "))
        runCurrent()
        assertEquals(listOf("add:ev-1:Book room"), s.meeting.writes)
        s.vm.close()
    }

    @Test fun `a suggestion becomes a task through its transcript and an unknown one does not`() = runTest(dispatcher) {
        val s = setup()
        runCurrent()
        s.vm.onAction(MeetingAction.AddSuggestion("tr-1", 7))
        runCurrent()
        assertEquals(emptyList(), s.tasks.writes)
        s.vm.onAction(MeetingAction.AddSuggestion("tr-1", 0))
        assertTrue(s.vm.state.value.suggestions.single().busy)
        runCurrent()
        assertEquals(listOf("task:tr-1:0"), s.tasks.writes)
        assertTrue(s.vm.state.value.suggestions.none { it.busy })
        s.vm.close()
    }

    @Test fun `a refused write leaves the page and dismissing it clears the failure`() = runTest(dispatcher) {
        val s = setup(meeting = ScriptedMeeting(write = { RepositoryResult.Failure(FailureKind.REJECTED) }))
        runCurrent()
        val loaded = s.vm.state.value
        s.vm.onAction(MeetingAction.ToggleTask("t1"))
        runCurrent()
        assertEquals(loaded.copy(writeFailure = Failed(FailureKind.REJECTED)), s.vm.state.value)
        assertEquals(1, s.events.calls)
        s.vm.onAction(MeetingAction.DismissFailure)
        assertEquals(loaded, s.vm.state.value)
        s.vm.close()
    }

    @Test fun `a write whose reread fails keeps the page and reports the failure`() = runTest(dispatcher) {
        val s =
            setup(events = listOf({ RepositoryResult.Content(EVENT) }, { RepositoryResult.Failure(UNREADABLE) }))
        runCurrent()
        s.vm.onAction(MeetingAction.AddTask("x"))
        runCurrent()
        assertEquals(MeetingPhase.CONTENT, s.vm.state.value.phase)
        assertEquals(Failed(FailureKind.UNAVAILABLE), s.vm.state.value.writeFailure)
        assertEquals(false, s.vm.state.value.working)
        s.vm.close()
    }

    @Test fun `a change while another runs or before the page loaded is ignored`() = runTest(dispatcher) {
        val s = setup()
        s.vm.onAction(MeetingAction.AddTask("early"))
        runCurrent()
        assertEquals(emptyList(), s.meeting.writes)
        s.vm.onAction(MeetingAction.AddTask("one"))
        s.vm.onAction(MeetingAction.AddTask("two"))
        runCurrent()
        assertEquals(listOf("add:ev-1:one"), s.meeting.writes)
        s.vm.close()
    }

    @Test fun `a recording in process makes the page read again until it is done`() = runTest(dispatcher) {
        val s = setup(
            recordings = listOf(
                { RepositoryResult.Content(listOf(recording(RecordingStatus.PROCESSING))) },
                { RepositoryResult.Content(listOf(recording())) },
            ),
        )
        runCurrent()
        assertTrue(s.vm.state.value.recordings.single().processing)
        advanceTimeBy(RECORDINGS_POLL_MILLIS)
        runCurrent()
        assertEquals(2, s.recordings.calls)
        assertEquals(false, s.vm.state.value.recordings.single().processing)
        advanceTimeBy(RECORDINGS_POLL_MILLIS * 3)
        runCurrent()
        assertEquals(2, s.recordings.calls)
        s.vm.close()
    }

    @Test fun `closing stops the polling`() = runTest(dispatcher) {
        val s = setup(recordings = listOf({ RepositoryResult.Content(listOf(recording(RecordingStatus.PROCESSING))) }))
        runCurrent()
        s.vm.close()
        advanceTimeBy(RECORDINGS_POLL_MILLIS * 2)
        runCurrent()
        assertEquals(1, s.recordings.calls)
    }

    @Test fun `opening things asks the app to show them`() = runTest(dispatcher) {
        val s = setup()
        runCurrent()
        val received = mutableListOf<MeetingEffect>()
        val collector = launch { s.vm.effects.collect { received += it } }
        s.vm.onAction(MeetingAction.OpenTask("t1"))
        s.vm.onAction(MeetingAction.OpenRecording("tr-1"))
        s.vm.onAction(MeetingAction.OpenNotes)
        s.vm.onAction(MeetingAction.OpenDetails)
        runCurrent()
        collector.cancel()
        assertEquals(
            listOf(
                MeetingEffect.ShowTask("t1"),
                MeetingEffect.ShowRecording("tr-1"),
                MeetingEffect.ShowNotes("ev-1"),
                MeetingEffect.ShowDetails("ev-1"),
            ),
            received,
        )
        s.vm.close()
    }

    @Test fun `a closed ViewModel ignores actions`() = runTest(dispatcher) {
        val s = setup()
        runCurrent()
        s.vm.close()
        s.vm.onAction(MeetingAction.Retry)
        s.vm.onAction(MeetingAction.AddTask("x"))
        runCurrent()
        assertEquals(1, s.events.calls)
        assertEquals(emptyList(), s.meeting.writes)
    }

    @Test fun `a write elsewhere in the window reads the event again`() = runTest(dispatcher) {
        val changes = MutableSharedFlow<Unit>(extraBufferCapacity = 1)
        val events = CallScript<WorkItem>(
            listOf<ScriptedStep<WorkItem>>(
                { RepositoryResult.Content(EVENT) },
                { RepositoryResult.Content(EVENT.copy(title = "Moved meeting")) },
            ),
        )
        val vm = MeetingViewModel(
            "ev-1",
            ScriptedEvents(events),
            ScriptedMeeting(),
            ScriptedEventRecordings(
                CallScript(
                    listOf<ScriptedStep<List<RecordingEntry>>>({ RepositoryResult.Content(listOf(recording())) }),
                ),
            ),
            SuggestionTasks(),
            changes,
        )
        runCurrent()
        changes.emit(Unit)
        runCurrent()
        assertEquals(2, events.calls)
        assertEquals("Moved meeting", vm.state.value.title)
        vm.close()
    }
}
