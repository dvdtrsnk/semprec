package cz.semprec.app.presentation

import cz.semprec.app.core.AudioPlayer
import cz.semprec.app.core.FailureKind
import cz.semprec.app.core.PlaybackSource
import cz.semprec.app.core.PlayerListener
import cz.semprec.app.core.RecordingStatus
import cz.semprec.app.core.TranscriptActionState
import cz.semprec.app.domain.RepositoryResult
import cz.semprec.app.domain.TranscriptActionItem
import cz.semprec.app.domain.TranscriptCandidate
import cz.semprec.app.domain.TranscriptContext
import cz.semprec.app.domain.TranscriptContextValue
import cz.semprec.app.domain.TranscriptDetail
import cz.semprec.app.domain.TranscriptEventRef
import cz.semprec.app.domain.TranscriptNotes
import cz.semprec.app.domain.TranscriptRepository
import cz.semprec.app.domain.TranscriptSegment
import cz.semprec.app.domain.TranscriptSpeaker
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

private val SEGMENTS = listOf(
    TranscriptSegment(0, "S1", "David", "Thanks for coming, budget first.", 10.0, 20.0),
    TranscriptSegment(1, "S2", "Petr", "The budget is fine with us.", 21.0, 30.0),
    TranscriptSegment(2, "S3", "Speaker 3", "I need the logos by Friday.", 31.0, 40.0),
)

private fun detail(
    items: List<TranscriptActionItem> = listOf(
        TranscriptActionItem(0, "Send the offer", "David", "2026-10-23", TranscriptActionState.OPEN, null, true),
        TranscriptActionItem(1, "Deliver the logos", "Petr", null, TranscriptActionState.ADDED, "t1", false),
    ),
    blobId: String? = "blob-1",
    status: RecordingStatus = RecordingStatus.DONE,
) = TranscriptDetail(
    id = "tr-1",
    name = "Client meeting",
    date = "2026-10-16T10:02:00+02:00",
    durationSeconds = 4867,
    language = "cs",
    status = status,
    speakers = listOf(
        TranscriptSpeaker("S1", 1, "David", "p1"),
        TranscriptSpeaker("S2", 2, "Petr", "p2"),
        TranscriptSpeaker("S3", 3, "Speaker 3", null),
    ),
    segments = SEGMENTS,
    notes = TranscriptNotes("Budget agreed.", listOf("Blog later"), items),
    event = TranscriptEventRef("ev-1", "Client meeting"),
    context = TranscriptContext(
        project = TranscriptContextValue("pr-1", "Web", inherited = true),
        company = null,
        people = listOf(TranscriptContextValue("p2", "Petr", inherited = false)),
    ),
    blobId = blobId,
)

private class ScriptedTranscript(
    details: List<ScriptedStep<TranscriptDetail>> = listOf({ RepositoryResult.Content(detail()) }),
    var candidates: ScriptedStep<List<TranscriptCandidate>> = {
        RepositoryResult.Content(
            listOf(TranscriptCandidate("p3", "Jana", null), TranscriptCandidate("p2", "Petr", "S3")),
        )
    },
    var write: ScriptedStep<Unit> = { RepositoryResult.Content(Unit) },
    var playback: RepositoryResult<PlaybackSource> =
        RepositoryResult.Content(PlaybackSource("https://s/api/blobs/blob-1", "Bearer tok")),
) : TranscriptRepository {
    val detailCalls = CallScript(details)
    val writes = mutableListOf<String>()

    override suspend fun detail(transcriptId: String) = detailCalls.next()

    override suspend fun candidates(transcriptId: String) = candidates()

    override suspend fun assignSpeaker(
        transcriptId: String,
        speaker: String,
        personId: String?,
    ): RepositoryResult<Unit> {
        writes += "assign:$speaker:$personId"
        return write()
    }

    override suspend fun note(transcriptId: String, actionItemId: Int, noted: Boolean): RepositoryResult<Unit> {
        writes += "note:$actionItemId:$noted"
        return write()
    }

    override suspend fun addTask(transcriptId: String, actionItemId: Int): RepositoryResult<Unit> {
        writes += "addTask:$actionItemId"
        return write()
    }

    override suspend fun removeTask(transcriptId: String, actionItemId: Int): RepositoryResult<Unit> {
        writes += "removeTask:$actionItemId"
        return write()
    }

    override suspend fun playback(blobId: String): RepositoryResult<PlaybackSource> = playback
}

private class LoggedPlayer : AudioPlayer {
    val log = mutableListOf<String>()
    var listener: PlayerListener? = null

    override fun prepare(source: PlaybackSource, listener: PlayerListener) {
        log += "prepare:${source.url}:${source.authorization}"
        this.listener = listener
    }

    override fun play() {
        log += "play"
    }

    override fun pause() {
        log += "pause"
    }

    override fun seekTo(seconds: Double) {
        log += "seek:$seconds"
    }

    override fun setRate(rate: Float) {
        log += "rate:$rate"
    }

    override fun release() {
        log += "release"
    }
}

@OptIn(ExperimentalCoroutinesApi::class)
class TranscriptViewModelTest : MainDispatcherTest() {
    private fun viewModel(repository: ScriptedTranscript, player: LoggedPlayer = LoggedPlayer()) =
        TranscriptViewModel("tr-1", repository, player)

    @Test fun `loads the notes the context and the segments with the voices that are nobody marked`() =
        runTest(dispatcher) {
            val vm = viewModel(ScriptedTranscript())
            assertEquals(TranscriptState(), vm.state.value)
            runCurrent()
            val state = vm.state.value
            assertEquals(TranscriptPhase.CONTENT, state.phase)
            assertEquals("Client meeting", state.title)
            assertEquals("Budget agreed.", state.summary)
            assertEquals(listOf("Blog later"), state.decisions)
            assertEquals(
                listOf(TranscriptActionState.OPEN, TranscriptActionState.ADDED),
                state.actionItems.map { it.state },
            )
            assertEquals("ev-1", state.eventId)
            assertEquals(TranscriptContextItem("pr-1", "Web", true), state.project)
            assertNull(state.company)
            assertEquals(listOf(true, true, false), state.segments.map { it.mapped })
            assertEquals(3, state.matchCount)
            vm.close()
        }

    @Test fun `a transcript without notes has no summary`() = runTest(dispatcher) {
        val bare = detail().copy(notes = null, event = null)
        val vm = viewModel(ScriptedTranscript(details = listOf({ RepositoryResult.Content(bare) })))
        runCurrent()
        assertNull(vm.state.value.summary)
        assertEquals(emptyList(), vm.state.value.actionItems)
        assertNull(vm.state.value.eventId)
        vm.onAction(TranscriptAction.OpenEvent)
        vm.close()
    }

    @Test fun `a failed load is an error and retry loads again`() = runTest(dispatcher) {
        val repository = ScriptedTranscript(
            details = listOf(
                { RepositoryResult.Failure(FailureKind.NOT_FOUND) },
                { RepositoryResult.Content(detail()) },
            ),
        )
        val vm = viewModel(repository)
        runCurrent()
        assertEquals(TranscriptState(TranscriptPhase.ERROR, FailureKind.NOT_FOUND), vm.state.value)
        vm.onAction(TranscriptAction.Retry)
        runCurrent()
        assertEquals(TranscriptPhase.CONTENT, vm.state.value.phase)
        vm.close()
    }

    @Test fun `an unexpected exception is an error without a kind`() = runTest(dispatcher) {
        val vm = viewModel(ScriptedTranscript(details = listOf(crashes())))
        runCurrent()
        assertEquals(TranscriptState(TranscriptPhase.ERROR, null), vm.state.value)
        vm.close()
    }

    @Test fun `a refresh keeps the transcript and a failed one leaves it as it was`() = runTest(dispatcher) {
        val repository = ScriptedTranscript(
            details = listOf(
                { RepositoryResult.Content(detail()) },
                { RepositoryResult.Failure(FailureKind.UNAVAILABLE) },
            ),
        )
        val vm = viewModel(repository)
        runCurrent()
        val loaded = vm.state.value
        vm.onAction(TranscriptAction.Refresh)
        assertEquals(loaded, vm.state.value)
        runCurrent()
        assertEquals(loaded, vm.state.value)
        vm.close()
    }

    @Test fun `a refresh without a transcript is a retry and a late read is dropped`() = runTest(dispatcher) {
        val gate = CompletableDeferred<Unit>()
        val repository = ScriptedTranscript(
            details = listOf(
                answersLate(gate, RepositoryResult.Content(detail().copy(name = "Stale"))),
                { RepositoryResult.Content(detail()) },
            ),
        )
        val vm = viewModel(repository)
        runCurrent()
        vm.onAction(TranscriptAction.Refresh)
        assertEquals(TranscriptPhase.LOADING, vm.state.value.phase)
        runCurrent()
        gate.complete(Unit)
        runCurrent()
        assertEquals("Client meeting", vm.state.value.title)
        vm.close()
    }

    @Test fun `the tab is chosen and the search narrows the segments by text and by speaker`() = runTest(dispatcher) {
        val vm = viewModel(ScriptedTranscript())
        runCurrent()
        vm.onAction(TranscriptAction.SelectTab(TranscriptTab.TRANSCRIPT))
        assertEquals(TranscriptTab.TRANSCRIPT, vm.state.value.tab)
        vm.onAction(TranscriptAction.Search("BUDGET"))
        assertEquals(listOf(0, 1), vm.state.value.segments.map { it.index })
        assertEquals(2, vm.state.value.matchCount)
        vm.onAction(TranscriptAction.Search("speaker 3"))
        assertEquals(listOf(2), vm.state.value.segments.map { it.index })
        vm.onAction(TranscriptAction.Search("nothing like it"))
        assertEquals(0, vm.state.value.matchCount)
        vm.onAction(TranscriptAction.Search("  "))
        assertEquals(3, vm.state.value.matchCount)
        vm.close()
    }

    @Test fun `the audio is prepared once with the server and the token and a refresh does not prepare it again`() =
        runTest(dispatcher) {
            val player = LoggedPlayer()
            val vm = viewModel(ScriptedTranscript(), player)
            runCurrent()
            assertEquals(listOf("prepare:https://s/api/blobs/blob-1:Bearer tok"), player.log)
            assertTrue(vm.state.value.player.available)
            vm.onAction(TranscriptAction.Refresh)
            runCurrent()
            assertEquals(1, player.log.size)
            vm.close()
        }

    @Test fun `no audio or a recording that is not done leaves the player unavailable`() = runTest(dispatcher) {
        val none = LoggedPlayer()
        val withoutAudio = viewModel(
            ScriptedTranscript(
                details = listOf({
                    RepositoryResult.Content(detail(blobId = null))
                })
            ),
            none
        )
        val processing = viewModel(
            ScriptedTranscript(
                details = listOf({ RepositoryResult.Content(detail(status = RecordingStatus.PROCESSING)) }),
            ),
            none,
        )
        runCurrent()
        assertEquals(emptyList(), none.log)
        assertEquals(false, withoutAudio.state.value.player.available)
        assertEquals(false, processing.state.value.player.available)
        withoutAudio.onAction(TranscriptAction.Player.TogglePlay)
        withoutAudio.onAction(TranscriptAction.Player.Seek(5.0))
        assertEquals(TranscriptPlayer(), withoutAudio.state.value.player)
        withoutAudio.close()
        processing.close()
    }

    @Test fun `a server that will not let the audio in marks the player failed`() = runTest(dispatcher) {
        val repository = ScriptedTranscript(playback = RepositoryResult.Failure(FailureKind.UNAUTHORIZED))
        val vm = viewModel(repository)
        runCurrent()
        assertTrue(vm.state.value.player.failed)
        assertEquals(false, vm.state.value.player.available)
        vm.close()
    }

    @Test fun `playing pausing seeking and the speed go to the player and the position marks the active segment`() =
        runTest(dispatcher) {
            val player = LoggedPlayer()
            val vm = viewModel(ScriptedTranscript(), player)
            runCurrent()
            vm.onAction(TranscriptAction.Player.TogglePlay)
            assertTrue(vm.state.value.player.playing)
            player.listener?.onDuration(4867.0)
            player.listener?.onPosition(22.5)
            assertEquals(4867.0, vm.state.value.player.duration)
            assertEquals(22.5, vm.state.value.player.position)
            assertEquals(listOf(false, true, false), vm.state.value.segments.map { it.active })
            vm.onAction(TranscriptAction.Player.Seek(35.0))
            assertEquals(listOf(false, false, true), vm.state.value.segments.map { it.active })
            vm.onAction(TranscriptAction.Player.CycleRate)
            vm.onAction(TranscriptAction.Player.CycleRate)
            vm.onAction(TranscriptAction.Player.CycleRate)
            assertEquals(1f, vm.state.value.player.rate)
            vm.onAction(TranscriptAction.Player.TogglePlay)
            assertEquals(false, vm.state.value.player.playing)
            assertEquals(
                listOf("play", "seek:35.0", "rate:1.5", "rate:2.0", "rate:1.0", "pause"),
                player.log.drop(1),
            )
            player.listener?.onPosition(1.0)
            assertEquals(listOf(false, false, false), vm.state.value.segments.map { it.active })
            vm.close()
        }

    @Test fun `the end of the audio stops playing and a failure of the device marks the player failed`() =
        runTest(dispatcher) {
            val player = LoggedPlayer()
            val vm = viewModel(ScriptedTranscript(), player)
            runCurrent()
            vm.onAction(TranscriptAction.Player.TogglePlay)
            player.listener?.onEnded()
            assertEquals(false, vm.state.value.player.playing)
            vm.onAction(TranscriptAction.Player.TogglePlay)
            player.listener?.onFailed()
            assertTrue(vm.state.value.player.failed)
            assertEquals(false, vm.state.value.player.playing)
            vm.onAction(TranscriptAction.Player.TogglePlay)
            assertEquals(listOf("prepare", "play", "play"), player.log.map { it.substringBefore(':') })
            vm.close()
        }

    @Test fun `closing releases the player once and a late report from the device changes nothing`() =
        runTest(dispatcher) {
            val player = LoggedPlayer()
            val vm = viewModel(ScriptedTranscript(), player)
            runCurrent()
            vm.close()
            runCurrent()
            vm.close()
            runCurrent()
            player.listener?.onPosition(30.0)
            assertEquals(1, player.log.count { it == "release" })
            assertEquals(0.0, vm.state.value.player.position)
        }

    @Test fun `closing before the transcript was read still releases the player and prepares nothing`() =
        runTest(dispatcher) {
            val player = LoggedPlayer()
            val vm = viewModel(ScriptedTranscript(), player)
            vm.close()
            runCurrent()
            assertEquals(listOf("release"), player.log)
        }

    @Test fun `the speaker menu lists the people of the event and marks the one the voice already is`() =
        runTest(dispatcher) {
            val vm = viewModel(ScriptedTranscript())
            runCurrent()
            vm.onAction(TranscriptAction.Speaker.OpenMenu("S3"))
            assertEquals("S3", vm.state.value.speakerMenu)
            runCurrent()
            val shown = vm.state.value.candidates.map { it.personId to it.current }
            assertEquals(listOf("p3" to false, "p2" to true), shown)
            vm.onAction(TranscriptAction.Speaker.CloseMenu)
            assertNull(vm.state.value.speakerMenu)
            assertEquals(emptyList(), vm.state.value.candidates)
            vm.close()
        }

    @Test fun `candidates that cannot be read close the menu and say why`() = runTest(dispatcher) {
        val repository = ScriptedTranscript(candidates = { RepositoryResult.Failure(FailureKind.UNAVAILABLE) })
        val vm = viewModel(repository)
        runCurrent()
        vm.onAction(TranscriptAction.Speaker.OpenMenu("S3"))
        runCurrent()
        assertNull(vm.state.value.speakerMenu)
        assertEquals(Failed(FailureKind.UNAVAILABLE), vm.state.value.writeFailure)
        vm.onAction(TranscriptAction.DismissFailure)
        assertNull(vm.state.value.writeFailure)
        vm.close()
    }

    @Test fun `a menu closed before its candidates arrive stays closed`() = runTest(dispatcher) {
        val gate = CompletableDeferred<Unit>()
        val repository = ScriptedTranscript(
            candidates = {
                gate.await()
                RepositoryResult.Content(listOf(TranscriptCandidate("p3", "Jana", null)))
            },
        )
        val vm = viewModel(repository)
        runCurrent()
        vm.onAction(TranscriptAction.Speaker.OpenMenu("S3"))
        runCurrent()
        vm.onAction(TranscriptAction.Speaker.CloseMenu)
        gate.complete(Unit)
        runCurrent()
        assertNull(vm.state.value.speakerMenu)
        assertEquals(emptyList(), vm.state.value.candidates)
        vm.close()
    }

    @Test fun `giving the voice to a person writes it then reads the transcript again`() = runTest(dispatcher) {
        val repository = ScriptedTranscript(
            details = listOf(
                { RepositoryResult.Content(detail()) },
                { RepositoryResult.Content(detail().copy(name = "Renamed")) },
            ),
        )
        val vm = viewModel(repository)
        runCurrent()
        vm.onAction(TranscriptAction.Speaker.OpenMenu("S3"))
        runCurrent()
        vm.onAction(TranscriptAction.Speaker.Assign("p3"))
        assertTrue(vm.state.value.working)
        runCurrent()
        assertEquals(listOf("assign:S3:p3"), repository.writes)
        assertEquals("Renamed", vm.state.value.title)
        assertEquals(false, vm.state.value.working)
        assertNull(vm.state.value.speakerMenu)
        vm.close()
    }

    @Test fun `assigning without an open menu does nothing and taking the assignment back sends null`() =
        runTest(dispatcher) {
            val repository = ScriptedTranscript()
            val vm = viewModel(repository)
            runCurrent()
            vm.onAction(TranscriptAction.Speaker.Assign("p3"))
            assertEquals(emptyList(), repository.writes)
            vm.onAction(TranscriptAction.Speaker.OpenMenu("S1"))
            runCurrent()
            vm.onAction(TranscriptAction.Speaker.Assign(null))
            runCurrent()
            assertEquals(listOf("assign:S1:null"), repository.writes)
            vm.close()
        }

    @Test fun `an action item becomes a task is followed or is taken back`() = runTest(dispatcher) {
        val repository = ScriptedTranscript()
        val vm = viewModel(repository)
        runCurrent()
        vm.onAction(TranscriptAction.AddTask(0))
        assertTrue(vm.state.value.actionItems.first { it.id == 0 }.busy)
        runCurrent()
        vm.onAction(TranscriptAction.Follow(1))
        runCurrent()
        vm.onAction(TranscriptAction.Undo(1))
        runCurrent()
        assertEquals(listOf("addTask:0", "note:1:true", "removeTask:1"), repository.writes)
        assertTrue(vm.state.value.actionItems.none { it.busy })
        vm.close()
    }

    @Test fun `undoing a followed item unfollows it and undoing an open item or an unknown one does nothing`() =
        runTest(dispatcher) {
            val noted = detail(
                items = listOf(
                    TranscriptActionItem(0, "Open", null, null, TranscriptActionState.OPEN, null, true),
                    TranscriptActionItem(1, "Noted", null, null, TranscriptActionState.NOTED, null, false),
                ),
            )
            val repository = ScriptedTranscript(details = listOf({ RepositoryResult.Content(noted) }))
            val vm = viewModel(repository)
            runCurrent()
            vm.onAction(TranscriptAction.Undo(0))
            vm.onAction(TranscriptAction.Undo(9))
            vm.onAction(TranscriptAction.Undo(1))
            runCurrent()
            assertEquals(listOf("note:1:false"), repository.writes)
            vm.close()
        }

    @Test fun `a refused write leaves the transcript as it was and says why`() = runTest(dispatcher) {
        val repository = ScriptedTranscript(write = { RepositoryResult.Failure(FailureKind.REJECTED) })
        val vm = viewModel(repository)
        runCurrent()
        val loaded = vm.state.value
        vm.onAction(TranscriptAction.AddTask(0))
        runCurrent()
        assertEquals(loaded.copy(writeFailure = Failed(FailureKind.REJECTED)), vm.state.value)
        assertEquals(1, repository.detailCalls.calls)
        vm.close()
    }

    @Test fun `a write whose reread fails keeps the page and reports the failure`() = runTest(dispatcher) {
        val repository = ScriptedTranscript(
            details = listOf(
                { RepositoryResult.Content(detail()) },
                { RepositoryResult.Failure(FailureKind.UNAVAILABLE) },
            ),
        )
        val vm = viewModel(repository)
        runCurrent()
        vm.onAction(TranscriptAction.AddTask(0))
        runCurrent()
        assertEquals(TranscriptPhase.CONTENT, vm.state.value.phase)
        assertEquals(Failed(FailureKind.UNAVAILABLE), vm.state.value.writeFailure)
        assertEquals(false, vm.state.value.working)
        vm.close()
    }

    @Test fun `a second change while one runs and a change before the load are ignored`() = runTest(dispatcher) {
        val repository = ScriptedTranscript()
        val vm = viewModel(repository)
        vm.onAction(TranscriptAction.AddTask(0))
        runCurrent()
        assertEquals(emptyList(), repository.writes)
        vm.onAction(TranscriptAction.AddTask(0))
        vm.onAction(TranscriptAction.Follow(1))
        runCurrent()
        assertEquals(listOf("addTask:0"), repository.writes)
        vm.close()
    }

    @Test fun `opening the event asks the app to show it once`() = runTest(dispatcher) {
        val vm = viewModel(ScriptedTranscript())
        runCurrent()
        val received = mutableListOf<TranscriptEffect>()
        val collector = launch { vm.effects.collect { received += it } }
        vm.onAction(TranscriptAction.OpenEvent)
        runCurrent()
        collector.cancel()
        assertEquals(listOf<TranscriptEffect>(TranscriptEffect.OpenEvent("ev-1")), received)
        vm.close()
    }

    @Test fun `a closed ViewModel ignores actions`() = runTest(dispatcher) {
        val repository = ScriptedTranscript()
        val vm = viewModel(repository)
        runCurrent()
        vm.close()
        vm.onAction(TranscriptAction.Retry)
        vm.onAction(TranscriptAction.AddTask(0))
        runCurrent()
        assertEquals(1, repository.detailCalls.calls)
        assertEquals(emptyList(), repository.writes)
    }
}
