package cz.alldots.app.presentation

import cz.alldots.app.core.AudioRecorder
import cz.alldots.app.core.CapturedAudio
import cz.alldots.app.core.FailureKind
import cz.alldots.app.domain.RecordingEntry
import cz.alldots.app.domain.RecordingsRepository
import cz.alldots.app.domain.RepositoryResult
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

private val TAKE = CapturedAudio("/tmp/take.m4a", "take.m4a", "audio/mp4", "2026-10-16T10:00:00+02:00", 42)

/** A device recorder that logs every call; [allowed] and [starts] script the microphone, [stopped] the file. */
private class LoggedRecorder(
    var allowed: Boolean = true,
    var starts: Boolean = true,
    var stopped: CapturedAudio? = TAKE,
    var imported: CapturedAudio? = TAKE,
) : AudioRecorder {
    val log = mutableListOf<String>()
    var seconds = 0.0

    override fun requestPermission(answer: (Boolean) -> Unit) {
        log += "permission"
        answer(allowed)
    }

    override fun start(): Boolean {
        log += "start"
        return starts
    }

    override fun pause() {
        log += "pause"
    }

    override fun resume() {
        log += "resume"
    }

    override fun stop(): CapturedAudio? {
        log += "stop"
        return stopped
    }

    override fun cancel() {
        log += "cancel"
    }

    override fun delete(audio: CapturedAudio) {
        log += "delete:${audio.fileName}"
    }

    override fun elapsedSeconds(): Double = seconds

    override fun level(): Float = LEVEL

    override fun importFile(path: String): CapturedAudio? {
        log += "import:$path"
        return imported
    }

    private companion object {
        const val LEVEL = 0.5f
    }
}

private class UploadingRecordings(private val uploads: List<ScriptedStep<Unit>>) : RecordingsRepository {
    val calls = CallScript(uploads)
    val sent = mutableListOf<Pair<String, String?>>()

    override suspend fun list(eventId: String?): RepositoryResult<List<RecordingEntry>> =
        RepositoryResult.Content(emptyList())

    override suspend fun upload(audio: CapturedAudio, eventId: String?): RepositoryResult<Unit> {
        sent += audio.fileName to eventId
        return calls.next()
    }
}

@OptIn(ExperimentalCoroutinesApi::class)
class RecorderViewModelTest : MainDispatcherTest() {
    private val ok: ScriptedStep<Unit> = { RepositoryResult.Content(Unit) }

    private fun viewModel(
        recorder: LoggedRecorder,
        vararg uploads: ScriptedStep<Unit>,
        eventId: String? = "event-1",
    ): Pair<RecorderViewModel, UploadingRecordings> {
        val repository = UploadingRecordings(uploads.toList().ifEmpty { listOf(ok) })
        return RecorderViewModel(eventId, recorder, repository) to repository
    }

    private suspend fun TestScope.effectsAfter(vm: RecorderViewModel, block: suspend () -> Unit): List<RecorderEffect> {
        val received = mutableListOf<RecorderEffect>()
        val collector = launch { vm.effects.collect { received += it } }
        block()
        runCurrent()
        collector.cancel()
        return received
    }

    @Test fun `it starts idle and a start asks for the microphone then records`() = runTest(dispatcher) {
        val recorder = LoggedRecorder()
        val (vm, _) = viewModel(recorder)
        assertEquals(RecorderState(), vm.state.value)
        vm.onAction(RecorderAction.Start)
        assertEquals(listOf("permission", "start"), recorder.log)
        assertEquals(RecorderPhase.RECORDING, vm.state.value.phase)
        vm.close()
    }

    @Test fun `a refused microphone is a permission problem and nothing starts`() = runTest(dispatcher) {
        val recorder = LoggedRecorder(allowed = false)
        val (vm, _) = viewModel(recorder)
        vm.onAction(RecorderAction.Start)
        assertEquals(RecorderState(RecorderPhase.FAILED, problem = RecorderProblem.PERMISSION_DENIED), vm.state.value)
        assertEquals(listOf("permission"), recorder.log)
        vm.close()
    }

    @Test fun `a microphone that does not start is a start problem and retry asks again`() = runTest(dispatcher) {
        val recorder = LoggedRecorder(starts = false)
        val (vm, _) = viewModel(recorder)
        vm.onAction(RecorderAction.Start)
        assertEquals(RecorderProblem.START_FAILED, vm.state.value.problem)
        recorder.starts = true
        vm.onAction(RecorderAction.Retry)
        assertEquals(RecorderPhase.RECORDING, vm.state.value.phase)
        assertEquals(listOf("permission", "start", "permission", "start"), recorder.log)
        vm.close()
    }

    @Test fun `the clock and the level are read while recording and not while paused`() = runTest(dispatcher) {
        val recorder = LoggedRecorder()
        val (vm, _) = viewModel(recorder)
        vm.onAction(RecorderAction.Start)
        recorder.seconds = 3.4
        advanceTimeBy(RECORDER_TICK_MILLIS)
        runCurrent()
        assertEquals(3, vm.state.value.elapsedSeconds)
        assertEquals(listOf(0.5f), vm.state.value.levels)

        vm.onAction(RecorderAction.Pause)
        assertEquals(RecorderPhase.PAUSED, vm.state.value.phase)
        recorder.seconds = 9.0
        advanceTimeBy(RECORDER_TICK_MILLIS * 5)
        runCurrent()
        assertEquals(3, vm.state.value.elapsedSeconds)

        vm.onAction(RecorderAction.Resume)
        assertEquals(RecorderPhase.RECORDING, vm.state.value.phase)
        advanceTimeBy(RECORDER_TICK_MILLIS)
        runCurrent()
        assertEquals(9, vm.state.value.elapsedSeconds)
        assertEquals(listOf("permission", "start", "pause", "resume"), recorder.log)
        vm.close()
    }

    @Test fun `the waveform keeps only the latest readings`() = runTest(dispatcher) {
        val recorder = LoggedRecorder()
        val (vm, _) = viewModel(recorder)
        vm.onAction(RecorderAction.Start)
        advanceTimeBy(RECORDER_TICK_MILLIS * (RECORDER_LEVEL_COUNT + 10))
        runCurrent()
        assertEquals(RECORDER_LEVEL_COUNT, vm.state.value.levels.size)
        vm.close()
    }

    @Test fun `pause resume and stop do nothing when they do not fit the phase`() = runTest(dispatcher) {
        val recorder = LoggedRecorder()
        val (vm, _) = viewModel(recorder)
        vm.onAction(RecorderAction.Pause)
        vm.onAction(RecorderAction.Resume)
        vm.onAction(RecorderAction.Stop)
        vm.onAction(RecorderAction.Discard)
        vm.onAction(RecorderAction.Retry)
        assertEquals(emptyList(), recorder.log)
        assertEquals(RecorderState(), vm.state.value)
        vm.close()
    }

    @Test fun `a second start while recording does nothing`() = runTest(dispatcher) {
        val recorder = LoggedRecorder()
        val (vm, _) = viewModel(recorder)
        vm.onAction(RecorderAction.Start)
        vm.onAction(RecorderAction.Start)
        assertEquals(listOf("permission", "start"), recorder.log)
        vm.close()
    }

    @Test fun `stopping uploads the file to the event then deletes it and tells the app`() = runTest(dispatcher) {
        val recorder = LoggedRecorder()
        val (vm, repository) = viewModel(recorder)
        vm.onAction(RecorderAction.Start)
        val effects = effectsAfter(vm) { vm.onAction(RecorderAction.Stop) }
        assertEquals(listOf<Pair<String, String?>>(TAKE.fileName to "event-1"), repository.sent)
        assertEquals(listOf("permission", "start", "stop", "delete:take.m4a"), recorder.log)
        assertEquals(RecorderState(), vm.state.value)
        assertEquals(listOf<RecorderEffect>(RecorderEffect.Uploaded), effects)
        vm.close()
    }

    @Test fun `a recording without an event is uploaded without one and shows the upload phase meanwhile`() =
        runTest(dispatcher) {
            val gate = CompletableDeferred<Unit>()
            val recorder = LoggedRecorder()
            val upload = answersLate<Unit>(gate, RepositoryResult.Content(Unit))
            val (vm, repository) = viewModel(recorder, upload, eventId = null)
            vm.onAction(RecorderAction.Start)
            vm.onAction(RecorderAction.Stop)
            runCurrent()
            assertEquals(RecorderPhase.UPLOADING, vm.state.value.phase)
            assertTrue(vm.state.value.busy)
            gate.complete(Unit)
            runCurrent()
            assertEquals(listOf<Pair<String, String?>>(TAKE.fileName to null), repository.sent)
            assertEquals(RecorderPhase.IDLE, vm.state.value.phase)
            vm.close()
        }

    @Test fun `a take that left no file is a capture problem`() = runTest(dispatcher) {
        val recorder = LoggedRecorder(stopped = null)
        val (vm, repository) = viewModel(recorder)
        vm.onAction(RecorderAction.Start)
        vm.onAction(RecorderAction.Stop)
        assertEquals(RecorderProblem.CAPTURE_FAILED, vm.state.value.problem)
        assertEquals(0, repository.calls.calls)
        vm.close()
    }

    @Test fun `a failed upload keeps the file and retry sends it again`() = runTest(dispatcher) {
        val recorder = LoggedRecorder()
        val (vm, repository) = viewModel(recorder, { RepositoryResult.Failure(FailureKind.UNAVAILABLE) }, ok)
        vm.onAction(RecorderAction.Start)
        vm.onAction(RecorderAction.Stop)
        runCurrent()
        assertEquals(RecorderPhase.FAILED, vm.state.value.phase)
        assertEquals(RecorderProblem.UPLOAD_FAILED, vm.state.value.problem)
        assertEquals(FailureKind.UNAVAILABLE, vm.state.value.failure)
        assertTrue(recorder.log.none { it.startsWith("delete") })

        val effects = effectsAfter(vm) { vm.onAction(RecorderAction.Retry) }
        assertEquals(2, repository.calls.calls)
        assertEquals(RecorderState(), vm.state.value)
        assertEquals(listOf<RecorderEffect>(RecorderEffect.Uploaded), effects)
        assertEquals("delete:take.m4a", recorder.log.last())
        vm.close()
    }

    @Test fun `a start waits for a failed file and discarding it deletes the file`() = runTest(dispatcher) {
        val recorder = LoggedRecorder()
        val (vm, _) = viewModel(recorder, { RepositoryResult.Failure(FailureKind.REJECTED) })
        vm.onAction(RecorderAction.Start)
        vm.onAction(RecorderAction.Stop)
        runCurrent()
        vm.onAction(RecorderAction.Start)
        assertEquals(listOf("permission", "start", "stop"), recorder.log)
        vm.onAction(RecorderAction.Discard)
        assertEquals(RecorderState(), vm.state.value)
        assertEquals("delete:take.m4a", recorder.log.last())
        vm.close()
    }

    @Test fun `discarding a take in progress cancels the microphone`() = runTest(dispatcher) {
        val recorder = LoggedRecorder()
        val (vm, repository) = viewModel(recorder)
        vm.onAction(RecorderAction.Start)
        vm.onAction(RecorderAction.Discard)
        assertEquals(listOf("permission", "start", "cancel"), recorder.log)
        assertEquals(RecorderState(), vm.state.value)
        advanceTimeBy(RECORDER_TICK_MILLIS * 3)
        runCurrent()
        assertEquals(0, vm.state.value.elapsedSeconds)
        assertEquals(0, repository.calls.calls)
        vm.close()
        runCurrent()
        assertEquals(listOf("permission", "start", "cancel"), recorder.log)
    }

    @Test fun `an imported file is uploaded and one that cannot be copied is an import problem`() =
        runTest(dispatcher) {
            val recorder = LoggedRecorder()
            val (vm, repository) = viewModel(recorder)
            vm.onAction(RecorderAction.Import("/files/a.m4a"))
            runCurrent()
            assertEquals(listOf("import:/files/a.m4a", "delete:take.m4a"), recorder.log)
            assertEquals(1, repository.calls.calls)

            recorder.imported = null
            vm.onAction(RecorderAction.Import("/files/b.m4a"))
            assertEquals(RecorderProblem.IMPORT_FAILED, vm.state.value.problem)
            assertEquals(1, repository.calls.calls)
            vm.close()
        }

    @Test fun `closing the screen during a take cancels the microphone once`() = runTest(dispatcher) {
        val recorder = LoggedRecorder()
        val (vm, _) = viewModel(recorder)
        vm.onAction(RecorderAction.Start)
        vm.close()
        runCurrent()
        vm.close()
        runCurrent()
        assertEquals(listOf("permission", "start", "cancel"), recorder.log)
    }

    @Test fun `closing the screen while paused also cancels the microphone`() = runTest(dispatcher) {
        val recorder = LoggedRecorder()
        val (vm, _) = viewModel(recorder)
        vm.onAction(RecorderAction.Start)
        vm.onAction(RecorderAction.Pause)
        vm.close()
        runCurrent()
        assertEquals(listOf("permission", "start", "pause", "cancel"), recorder.log)
    }

    @Test fun `closing after a take was stopped does not cancel it`() = runTest(dispatcher) {
        val recorder = LoggedRecorder()
        val (vm, _) = viewModel(recorder, neverAnswers<Unit>())
        vm.onAction(RecorderAction.Start)
        vm.onAction(RecorderAction.Stop)
        runCurrent()
        vm.close()
        runCurrent()
        assertEquals(listOf("permission", "start", "stop"), recorder.log)
    }

    @Test fun `a closed ViewModel ignores actions`() = runTest(dispatcher) {
        val recorder = LoggedRecorder()
        val (vm, _) = viewModel(recorder)
        vm.close()
        vm.onAction(RecorderAction.Start)
        assertEquals(emptyList(), recorder.log)
        assertEquals(RecorderState(), vm.state.value)
    }
}
