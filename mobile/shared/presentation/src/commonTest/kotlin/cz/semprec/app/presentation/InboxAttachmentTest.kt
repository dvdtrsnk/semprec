package cz.semprec.app.presentation

import cz.semprec.app.core.FailureKind
import cz.semprec.app.domain.InboxAttachmentLocation
import cz.semprec.app.domain.InboxOrigin
import cz.semprec.app.domain.RepositoryResult
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

private fun cardWithFiles(id: String) = inboxTaskCard(id).let { card ->
    val origin = card.origin as InboxOrigin.Capture
    card.copy(origin = origin.copy(attachments = listOf(serverAttachment("f1", name = null), serverAttachment("f2"))))
}

/** Opening a file of the source of an Inbox card for a preview. */
@OptIn(ExperimentalCoroutinesApi::class)
class InboxAttachmentTest : MainDispatcherTest() {
    private val attachments = FakeAttachmentFiles()

    private fun TestScope.loaded(): InboxViewModel =
        inboxFactory(ScriptedInbox(inboxContent(cardWithFiles("c1"))), attachments).inboxViewModel()
            .also { runCurrent() }

    @Test fun `a card lists the files of its source by name and media type`() = runTest(dispatcher) {
        val vm = loaded()

        assertEquals(
            listOf(
                AttachmentState("f1", null, "application/pdf"),
                AttachmentState("f2", "scan.pdf", "application/pdf"),
            ),
            vm.state.value.cards.single().origin?.attachments,
        )
        vm.close()
    }

    @Test fun `a file of the card's source shows its wait and then the file to preview`() = runTest(dispatcher) {
        val gate = CompletableDeferred<Unit>()
        attachments.answer = { _, name ->
            gate.await()
            RepositoryResult.Content("/cache/$name")
        }
        val vm = loaded()

        vm.onAction(InboxAction.OpenAttachment("c1", "f1"))
        assertEquals(AttachmentPreviewState("f1", AttachmentPreviewPhase.OPENING), vm.state.value.attachment)
        gate.complete(Unit)
        runCurrent()

        assertEquals(
            AttachmentPreviewState("f1", AttachmentPreviewPhase.OPEN, path = "/cache/Attachment.pdf"),
            vm.state.value.attachment,
        )
        val asked: Pair<InboxAttachmentLocation, String> =
            InboxAttachmentLocation.Blob("blob-f1") to "Attachment.pdf"
        assertEquals(listOf(asked), attachments.calls)
        vm.onAction(InboxAction.CloseAttachment)
        assertNull(vm.state.value.attachment)
        vm.close()
    }

    @Test fun `a download failure shows its kind and nothing opens`() = runTest(dispatcher) {
        attachments.answer = { _, _ -> RepositoryResult.Failure(FailureKind.UNAVAILABLE) }
        val vm = loaded()

        vm.onAction(InboxAction.OpenAttachment("c1", "f2"))
        runCurrent()

        assertEquals(
            AttachmentPreviewState("f2", AttachmentPreviewPhase.FAILED, failure = FailureKind.UNAVAILABLE),
            vm.state.value.attachment,
        )
        vm.close()
    }

    @Test fun `a file of a card not in the stack fails as not found`() = runTest(dispatcher) {
        val vm = loaded()

        vm.onAction(InboxAction.OpenAttachment("gone", "f1"))
        runCurrent()

        assertEquals(FailureKind.NOT_FOUND, vm.state.value.attachment?.failure)
        assertEquals(emptyList(), attachments.calls)
        vm.close()
    }
}
