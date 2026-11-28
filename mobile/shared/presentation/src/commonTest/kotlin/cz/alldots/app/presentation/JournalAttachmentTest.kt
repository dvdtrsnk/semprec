package cz.alldots.app.presentation

import cz.alldots.app.core.FailureKind
import cz.alldots.app.domain.InboxAttachmentLocation
import cz.alldots.app.domain.RepositoryResult
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

/** Opening an attachment of the diary's Inbox for a preview. */
@OptIn(ExperimentalCoroutinesApi::class)
class JournalAttachmentTest : MainDispatcherTest() {
    private val repository = FakeJournalRepository()
    private val attachments = FakeAttachmentFiles()
    private val changes = MutableSharedFlow<Unit>(extraBufferCapacity = 1)

    private fun TestScope.loaded(): JournalViewModel =
        JournalViewModelFactory(repository, UnusedInboxCaptures, attachments, changes)
            .journalViewModel("2026-10-16")
            .also { runCurrent() }

    @Test fun `an attachment shows its wait and then the file to preview named for its media type`() =
        runTest(dispatcher) {
            val gate = CompletableDeferred<Unit>()
            attachments.answer = { _, name ->
                gate.await()
                RepositoryResult.Content("/cache/$name")
            }
            val vm = loaded()

            vm.onAction(JournalAction.OpenAttachment("i1", "a2"))
            assertEquals(AttachmentPreviewState("a2", AttachmentPreviewPhase.OPENING), vm.state.value.attachment)
            gate.complete(Unit)
            runCurrent()

            assertEquals(
                AttachmentPreviewState("a2", AttachmentPreviewPhase.OPEN, path = "/cache/Attachment.jpg"),
                vm.state.value.attachment,
            )
            val asked: Pair<InboxAttachmentLocation, String> =
                InboxAttachmentLocation.Blob("blob-a2") to "Attachment.jpg"
            assertEquals(listOf(asked), attachments.calls)
            vm.onAction(JournalAction.CloseAttachment)
            assertNull(vm.state.value.attachment)
            vm.close()
        }

    @Test fun `a failure to open shows its kind and no file`() = runTest(dispatcher) {
        attachments.answer = { _, _ -> RepositoryResult.Failure(FailureKind.UNAVAILABLE) }
        val vm = loaded()

        vm.onAction(JournalAction.OpenAttachment("i1", "a1"))
        runCurrent()

        assertEquals(
            AttachmentPreviewState("a1", AttachmentPreviewPhase.FAILED, failure = FailureKind.UNAVAILABLE),
            vm.state.value.attachment,
        )
        vm.close()
    }

    @Test fun `an attachment the diary does not list fails as not found without asking for a file`() =
        runTest(dispatcher) {
            val vm = loaded()

            vm.onAction(JournalAction.OpenAttachment("i1", "missing"))
            runCurrent()

            assertEquals(
                AttachmentPreviewState("missing", AttachmentPreviewPhase.FAILED, failure = FailureKind.NOT_FOUND),
                vm.state.value.attachment,
            )
            assertEquals(emptyList(), attachments.calls)
            vm.close()
        }

    @Test fun `closing while an attachment is opened cancels it and a newer open supersedes an older`() =
        runTest(dispatcher) {
            val gates = mutableMapOf<String, CompletableDeferred<Unit>>()
            attachments.answer = { _, name ->
                gates.getOrPut(name) { CompletableDeferred() }.await()
                RepositoryResult.Content("/cache/$name")
            }
            val vm = loaded()

            vm.onAction(JournalAction.OpenAttachment("i1", "a1"))
            runCurrent()
            vm.onAction(JournalAction.CloseAttachment)
            gates.getValue("scan.pdf").complete(Unit)
            runCurrent()
            assertNull(vm.state.value.attachment, "a closed open never shows")

            vm.onAction(JournalAction.OpenAttachment("i1", "a2"))
            runCurrent()
            vm.onAction(JournalAction.OpenAttachment("i1", "a1"))
            runCurrent()
            gates.getValue("Attachment.jpg").complete(Unit)
            runCurrent()
            assertEquals(
                AttachmentPreviewState("a1", AttachmentPreviewPhase.OPEN, path = "/cache/scan.pdf"),
                vm.state.value.attachment,
            )
            vm.close()
        }

    @Test fun `an attachment opens while the diary reads the day again after a write`() = runTest(dispatcher) {
        val vm = loaded()
        val gate = CompletableDeferred<Unit>()
        repository.onPeriod = {
            gate.await()
            RepositoryResult.Content(periodPage(it))
        }
        changes.emit(Unit)
        runCurrent()

        vm.onAction(JournalAction.OpenAttachment("i1", "a1"))
        runCurrent()

        assertEquals(AttachmentPreviewPhase.OPEN, vm.state.value.attachment?.phase)
        gate.complete(Unit)
        runCurrent()
        vm.close()
    }

    @Test fun `a closed diary ignores an open`() = runTest(dispatcher) {
        val vm = loaded()
        vm.close()

        vm.onAction(JournalAction.OpenAttachment("i1", "a1"))
        runCurrent()

        assertNull(vm.state.value.attachment)
        assertEquals(emptyList(), attachments.calls)
    }
}
