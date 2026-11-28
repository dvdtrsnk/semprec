package cz.alldots.app.presentation

import cz.alldots.app.core.FailureKind
import cz.alldots.app.domain.InboxCapture
import cz.alldots.app.domain.InboxCaptureRepository
import cz.alldots.app.domain.InboxCaptureSource
import cz.alldots.app.domain.InboxType
import cz.alldots.app.domain.RepositoryResult
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/** "abc" as Base64. */
private const val CAPTURE_BYTES = "YWJj"

/** Captures and type reads whose answers a test replaces; every call is recorded. */
private class ScriptedCaptureRepository : InboxCaptureRepository {
    val captures = mutableListOf<InboxCapture>()
    var typeReads = 0
    var onTypes: suspend () -> RepositoryResult<List<InboxType>> = {
        RepositoryResult.Content(listOf(InboxType("t1", "Task", "T", "Tasks"), InboxType("t2", "Thought", "S", null)))
    }
    var onCapture: suspend (InboxCapture) -> RepositoryResult<Unit> = { RepositoryResult.Content(Unit) }

    override suspend fun types(): RepositoryResult<List<InboxType>> {
        typeReads += 1
        return onTypes()
    }

    override suspend fun capture(capture: InboxCapture): RepositoryResult<Unit> {
        captures += capture
        return onCapture(capture)
    }
}

@OptIn(ExperimentalCoroutinesApi::class)
class InboxCaptureViewModelTest : MainDispatcherTest() {
    private val repository = ScriptedCaptureRepository()

    private fun viewModel() = InboxCaptureViewModel(repository)

    private fun attach(filename: String, mimeType: String, source: InboxCaptureAttachmentSource) =
        InboxCaptureAction.Attach(filename, mimeType, CAPTURE_BYTES, source)

    private fun TestScope.effects(vm: InboxCaptureViewModel): MutableList<InboxCaptureEffect> {
        val seen = mutableListOf<InboxCaptureEffect>()
        backgroundScope.launch { vm.effects.collect { seen += it } }
        runCurrent()
        return seen
    }

    @Test fun `the types load once when asked for`() = runTest(dispatcher) {
        val vm = viewModel()
        assertEquals(InboxCapturePhase.IDLE, vm.state.value.typesPhase)
        vm.onAction(InboxCaptureAction.LoadTypes)
        assertEquals(InboxCapturePhase.LOADING, vm.state.value.typesPhase)
        vm.onAction(InboxCaptureAction.LoadTypes)
        runCurrent()
        vm.onAction(InboxCaptureAction.LoadTypes)
        runCurrent()
        assertEquals(1, repository.typeReads)
        assertEquals(InboxCapturePhase.READY, vm.state.value.typesPhase)
        assertEquals(
            listOf(InboxCaptureTypeState("t1", "Task", "T"), InboxCaptureTypeState("t2", "Thought", "S")),
            vm.state.value.types,
        )
        vm.close()
    }

    @Test fun `types that fail to load can be asked for again`() = runTest(dispatcher) {
        repository.onTypes = { RepositoryResult.Failure(FailureKind.UNAVAILABLE) }
        val vm = viewModel()
        vm.onAction(InboxCaptureAction.LoadTypes)
        runCurrent()
        assertEquals(InboxCapturePhase.FAILED, vm.state.value.typesPhase)
        repository.onTypes = { RepositoryResult.Content(emptyList()) }
        vm.onAction(InboxCaptureAction.LoadTypes)
        runCurrent()
        assertEquals(InboxCapturePhase.READY, vm.state.value.typesPhase)
        assertEquals(2, repository.typeReads)
        vm.close()
    }

    @Test fun `only a loaded type or none can be picked`() = runTest(dispatcher) {
        val vm = viewModel()
        vm.onAction(InboxCaptureAction.PickType("t1"))
        assertNull(vm.state.value.typeId, "No type is known before the types load")
        vm.onAction(InboxCaptureAction.LoadTypes)
        runCurrent()
        vm.onAction(InboxCaptureAction.PickType("t2"))
        assertEquals("t2", vm.state.value.typeId)
        vm.onAction(InboxCaptureAction.PickType("unknown"))
        assertEquals("t2", vm.state.value.typeId)
        vm.onAction(InboxCaptureAction.PickType(null))
        assertNull(vm.state.value.typeId)
        vm.close()
    }

    @Test fun `a file is attached with its size and can be removed`() = runTest(dispatcher) {
        val vm = viewModel()
        vm.onAction(attach("a.png", "image/png", InboxCaptureAttachmentSource.CAMERA))
        assertEquals(InboxCaptureAttachmentState("a.png", "image/png", 3), vm.state.value.attachment)
        vm.onAction(InboxCaptureAction.RemoveAttachment)
        assertNull(vm.state.value.attachment)
        vm.onAction(InboxCaptureAction.Submit("", "2026-11-16", "08:00"))
        runCurrent()
        assertTrue(repository.captures.isEmpty(), "A removed file is not sent")
        vm.close()
    }

    @Test fun `a file that is not Base64 is invalid data and nothing is attached`() = runTest(dispatcher) {
        val vm = viewModel()
        vm.onAction(InboxCaptureAction.Attach("a.png", "image/png", "%%%", InboxCaptureAttachmentSource.FILES))
        assertNull(vm.state.value.attachment)
        assertEquals(Failed(FailureKind.INVALID_DATA), vm.state.value.failure)
        vm.onAction(InboxCaptureAction.DismissFailure)
        assertNull(vm.state.value.failure)
        vm.close()
    }

    @Test fun `a capture is sent with its text type and file and then cleared`() = runTest(dispatcher) {
        val vm = viewModel()
        val seen = effects(vm)
        vm.onAction(InboxCaptureAction.LoadTypes)
        runCurrent()
        vm.onAction(InboxCaptureAction.PickType("t1"))
        vm.onAction(attach("a.png", "image/png", InboxCaptureAttachmentSource.PHOTO_LIBRARY))
        vm.onAction(InboxCaptureAction.Submit("  Buy tiles  ", "2026-11-16", "08:15"))
        assertTrue(vm.state.value.sending)
        runCurrent()
        val sent = repository.captures.single()
        assertEquals("Buy tiles", sent.text)
        assertEquals("2026-11-16", sent.day.toString())
        assertEquals("08:15", sent.time)
        assertEquals("t1", sent.typeId)
        assertEquals(InboxCaptureSource.PHOTO_LIBRARY, sent.file?.source)
        assertEquals("abc", sent.file?.bytes?.decodeToString())
        assertEquals(listOf<InboxCaptureEffect>(InboxCaptureEffect.Captured), seen)
        val after = vm.state.value
        assertFalse(after.sending)
        assertNull(after.attachment)
        assertNull(after.typeId)
        vm.close()
    }

    @Test fun `a blank text without a file or a day that is no day is not sent`() = runTest(dispatcher) {
        val vm = viewModel()
        vm.onAction(InboxCaptureAction.Submit("   ", "2026-11-16", "08:00"))
        vm.onAction(InboxCaptureAction.Submit("Note", "someday", "08:00"))
        runCurrent()
        assertTrue(repository.captures.isEmpty())
        assertFalse(vm.state.value.sending)
        vm.close()
    }

    @Test fun `a file alone is a capture`() = runTest(dispatcher) {
        val vm = viewModel()
        vm.onAction(attach("a.pdf", "application/pdf", InboxCaptureAttachmentSource.FILES))
        vm.onAction(InboxCaptureAction.Submit("", "2026-11-16", "08:00"))
        runCurrent()
        assertEquals("", repository.captures.single().text)
        vm.close()
    }

    @Test fun `a refused capture keeps the file and says why and a second send waits`() = runTest(dispatcher) {
        val gate = CompletableDeferred<RepositoryResult<Unit>>()
        repository.onCapture = { gate.await() }
        val vm = viewModel()
        val seen = effects(vm)
        vm.onAction(attach("a.png", "image/png", InboxCaptureAttachmentSource.CAMERA))
        vm.onAction(InboxCaptureAction.Submit("Note", "2026-11-16", "08:00"))
        runCurrent()
        vm.onAction(InboxCaptureAction.Submit("Note", "2026-11-16", "08:00"))
        runCurrent()
        assertEquals(1, repository.captures.size, "Nothing is sent twice at once")
        gate.complete(RepositoryResult.Failure(FailureKind.REJECTED))
        runCurrent()
        assertEquals(Failed(FailureKind.REJECTED), vm.state.value.failure)
        assertFalse(vm.state.value.sending)
        assertEquals("a.png", vm.state.value.attachment?.filename)
        assertTrue(seen.isEmpty())
        vm.close()
    }

    @Test fun `an unexpected exception is a failure without a kind`() = runTest(dispatcher) {
        repository.onCapture = { error("boom") }
        val vm = viewModel()
        vm.onAction(InboxCaptureAction.Submit("Note", "2026-11-16", "08:00"))
        runCurrent()
        assertEquals(Failed(null), vm.state.value.failure)
        vm.close()
    }

    @Test fun `closing ignores every action and an answer that comes late is not shown`() = runTest(dispatcher) {
        val gate = CompletableDeferred<RepositoryResult<Unit>>()
        repository.onCapture = { gate.await() }
        val vm = viewModel()
        vm.onAction(InboxCaptureAction.Submit("Note", "2026-11-16", "08:00"))
        runCurrent()
        vm.close()
        gate.complete(RepositoryResult.Content(Unit))
        runCurrent()
        assertTrue(vm.state.value.sending, "The cancelled send publishes nothing")
        vm.onAction(InboxCaptureAction.LoadTypes)
        runCurrent()
        assertEquals(0, repository.typeReads)
    }
}
