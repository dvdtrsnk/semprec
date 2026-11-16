package cz.semprec.app.presentation

import androidx.lifecycle.ViewModelStore
import cz.semprec.app.core.CapturedAudio
import cz.semprec.app.core.FailureKind
import cz.semprec.app.core.RecordingPairing
import cz.semprec.app.core.RecordingStatus
import cz.semprec.app.domain.RecordingEntry
import cz.semprec.app.domain.RecordingsRepository
import cz.semprec.app.domain.RepositoryResult
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

private fun entry(
    id: String,
    status: RecordingStatus? = RecordingStatus.DONE,
    pairing: RecordingPairing = RecordingPairing.NONE,
) =
    RecordingEntry(id, "Name $id", "2026-10-16T10:02:00+02:00", 4867, status, pairing, null, null, null)

private class ScriptedRecordings(
    lists: List<ScriptedStep<List<RecordingEntry>>>,
) : RecordingsRepository {
    val listCalls = CallScript(lists)

    override suspend fun list(eventId: String?) = listCalls.next()

    override suspend fun upload(audio: CapturedAudio, eventId: String?): RepositoryResult<Unit> =
        RepositoryResult.Content(Unit)
}

@OptIn(ExperimentalCoroutinesApi::class)
class RecordingsViewModelTest : MainDispatcherTest() {
    private fun viewModel(
        vararg lists: ScriptedStep<List<RecordingEntry>>
    ): Pair<RecordingsViewModel, ScriptedRecordings> {
        val repository = ScriptedRecordings(lists.toList())
        return RecordingsViewModel(repository) to repository
    }

    @Test fun `loads the recordings and shows them as rows`() = runTest(dispatcher) {
        val (vm, _) = viewModel({ RepositoryResult.Content(listOf(entry("a"), entry("b"))) })
        assertEquals(RecordingsState(), vm.state.value)
        runCurrent()
        assertEquals(RecordingsPhase.CONTENT, vm.state.value.phase)
        assertEquals(listOf("a", "b"), vm.state.value.recordings.map { it.id })
        assertEquals(false, vm.state.value.recordings[0].processing)
        vm.close()
    }

    @Test fun `a failed load is an error with its kind and retry loads again`() = runTest(dispatcher) {
        val (vm, repository) = viewModel(
            { RepositoryResult.Failure(FailureKind.UNAVAILABLE) },
            { RepositoryResult.Content(listOf(entry("a"))) },
        )
        runCurrent()
        assertEquals(RecordingsState(RecordingsPhase.ERROR, FailureKind.UNAVAILABLE), vm.state.value)
        vm.onAction(RecordingsAction.Retry)
        assertEquals(RecordingsPhase.LOADING, vm.state.value.phase)
        runCurrent()
        assertEquals(RecordingsPhase.CONTENT, vm.state.value.phase)
        assertEquals(2, repository.listCalls.calls)
        vm.close()
    }

    @Test fun `an unexpected exception is an error without a kind`() = runTest(dispatcher) {
        val (vm, _) = viewModel(crashes())
        runCurrent()
        assertEquals(RecordingsState(RecordingsPhase.ERROR, null), vm.state.value)
        vm.close()
    }

    @Test fun `a refresh keeps the list while it reloads and a failed one leaves it as it was`() = runTest(dispatcher) {
        val gate = CompletableDeferred<Unit>()
        val (vm, _) = viewModel(
            { RepositoryResult.Content(listOf(entry("a"))) },
            {
                gate.await()
                RepositoryResult.Failure(FailureKind.UNAVAILABLE)
            },
        )
        runCurrent()
        val loaded = vm.state.value
        vm.onAction(RecordingsAction.Refresh)
        assertEquals(loaded, vm.state.value)
        gate.complete(Unit)
        runCurrent()
        assertEquals(loaded, vm.state.value)
        vm.close()
    }

    @Test fun `a refresh without a list is a retry`() = runTest(dispatcher) {
        val (vm, _) = viewModel(
            { RepositoryResult.Failure(FailureKind.UNAVAILABLE) },
            { RepositoryResult.Content(listOf(entry("a"))) },
        )
        runCurrent()
        vm.onAction(RecordingsAction.Refresh)
        assertEquals(RecordingsPhase.LOADING, vm.state.value.phase)
        runCurrent()
        assertEquals(RecordingsPhase.CONTENT, vm.state.value.phase)
        vm.close()
    }

    @Test fun `a newer read cancels the one before and a late answer is not published`() = runTest(dispatcher) {
        val gate = CompletableDeferred<Unit>()
        val (vm, repository) = viewModel(
            answersLate(gate, RepositoryResult.Content(listOf(entry("stale")))),
            { RepositoryResult.Content(listOf(entry("fresh"))) },
        )
        runCurrent()
        vm.onAction(RecordingsAction.Retry)
        runCurrent()
        gate.complete(Unit)
        runCurrent()
        assertEquals(listOf("fresh"), vm.state.value.recordings.map { it.id })
        assertEquals(2, repository.listCalls.calls)
        vm.close()
    }

    @Test fun `a recording in process makes the list read again until none is`() = runTest(dispatcher) {
        val busy = entry("a", RecordingStatus.PROCESSING)
        val awaiting = entry("b", RecordingStatus.DONE, RecordingPairing.PROCESSING)
        val (vm, repository) = viewModel(
            { RepositoryResult.Content(listOf(busy, awaiting)) },
            { RepositoryResult.Content(listOf(entry("a"), awaiting)) },
            { RepositoryResult.Content(listOf(entry("a"), entry("b"))) },
        )
        runCurrent()
        assertTrue(vm.state.value.recordings.all { it.processing })
        advanceTimeBy(RECORDINGS_POLL_MILLIS)
        runCurrent()
        assertEquals(2, repository.listCalls.calls)
        assertEquals(RecordingsPhase.CONTENT, vm.state.value.phase)
        advanceTimeBy(RECORDINGS_POLL_MILLIS)
        runCurrent()
        assertEquals(3, repository.listCalls.calls)
        advanceTimeBy(RECORDINGS_POLL_MILLIS * 3)
        runCurrent()
        assertEquals(3, repository.listCalls.calls)
        vm.close()
    }

    @Test fun `closing stops the polling and a late poll never publishes`() = runTest(dispatcher) {
        val (vm, repository) = viewModel(
            { RepositoryResult.Content(listOf(entry("a", RecordingStatus.PROCESSING))) },
            { RepositoryResult.Content(listOf(entry("a"))) },
        )
        runCurrent()
        vm.close()
        advanceTimeBy(RECORDINGS_POLL_MILLIS * 2)
        runCurrent()
        assertEquals(1, repository.listCalls.calls)
        assertEquals(RecordingStatus.PROCESSING, vm.state.value.recordings.single().status)
    }

    @Test fun `opening a recording asks the app to show its transcript once`() = runTest(dispatcher) {
        val (vm, _) = viewModel({ RepositoryResult.Content(listOf(entry("a"))) })
        runCurrent()
        val received = mutableListOf<RecordingsEffect>()
        val collector = launch { vm.effects.collect { received += it } }
        vm.onAction(RecordingsAction.Open("a"))
        runCurrent()
        collector.cancel()
        assertEquals(listOf<RecordingsEffect>(RecordingsEffect.OpenTranscript("a")), received)
        vm.close()
    }

    @Test fun `a closed ViewModel ignores actions and its last state stays readable`() = runTest(dispatcher) {
        val (vm, repository) = viewModel({ RepositoryResult.Content(listOf(entry("a"))) })
        runCurrent()
        vm.close()
        vm.close()
        vm.onAction(RecordingsAction.Retry)
        runCurrent()
        assertEquals(1, repository.listCalls.calls)
        assertEquals(RecordingsPhase.CONTENT, vm.state.value.phase)
        assertEquals(emptyList(), vm.effects.toList())
    }

    @Test fun `clearing the store ends the ViewModel like close`() = runTest(dispatcher) {
        val store = ViewModelStore()
        val repository = ScriptedRecordings(listOf({ RepositoryResult.Content(listOf(entry("a"))) }))
        val vm = store.provide { RecordingsViewModel(repository) }
        runCurrent()
        store.clear()
        assertTrue(vm.isClosed)
    }
}
