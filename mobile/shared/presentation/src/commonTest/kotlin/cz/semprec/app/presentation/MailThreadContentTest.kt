package cz.semprec.app.presentation

import cz.semprec.app.core.FailureKind
import cz.semprec.app.core.MailContentUnavailable
import cz.semprec.app.domain.MailContentOutcome
import cz.semprec.app.domain.MailContentState.CACHED
import cz.semprec.app.domain.MailContentState.REMOTE
import cz.semprec.app.domain.MailMessageContent
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

/** The bodies a thread fetches from the mail provider and the attachments it saves into Files. */
@OptIn(ExperimentalCoroutinesApi::class)
class MailThreadContentTest : MainDispatcherTest() {
    private fun viewModel(mail: ScriptedMailRepository) =
        MailViewModelFactory(mail, mail, ScriptedMailDraftRepository(), ScriptedMailboxRepository(), mail, mail)
            .threadViewModel("t1")

    /** An older remote message, a cached one, and the newest one, remote, which the thread opens with. */
    private val remoteThread = mailDetail(
        messages = listOf(
            mailMessage("e1", state = REMOTE),
            mailMessage("e2", state = CACHED),
            mailMessage("e3", state = REMOTE, attachments = listOf(mailAttachment("a1"), mailAttachment("a2", "f2"))),
        ),
    )

    private fun MailThreadViewModel.message(id: String) = state.value.messages.single { it.emailId == id }

    private fun MailThreadViewModel.file(id: String) = message("e3").attachments.single { it.attachmentId == id }

    private fun repository(vararg contents: ScriptedStep<MailContentOutcome<MailMessageContent>>) =
        ScriptedMailRepository(
            thread = MailCall(mailContent(remoteThread)),
            contents = MailCall(*contents.ifEmpty { arrayOf(mailFetched(MailMessageContent("e3", "Celý text"))) }),
        )

    @Test fun `the newest message is fetched when the thread shows and the others only show their preview`() =
        runTest(dispatcher) {
            val mail = repository()
            val vm = viewModel(mail)
            runCurrent()
            assertEquals(listOf("e3"), mail.contents.asked)
            assertEquals(MailBodyPhase.READY, vm.message("e3").bodyPhase)
            assertEquals("Celý text", vm.message("e3").bodyText)
            assertEquals(MailBodyPhase.REMOTE, vm.message("e1").bodyPhase)
            assertEquals("", vm.message("e1").bodyText)
            assertEquals("Ahoj", vm.message("e1").preview)
            assertEquals(MailBodyPhase.READY, vm.message("e2").bodyPhase)
            assertEquals("Ahoj e2", vm.message("e2").bodyText)
            vm.close()
        }

    @Test fun `a body being fetched shows as loading`() = runTest(dispatcher) {
        val vm = viewModel(repository(neverAnswers()))
        runCurrent()
        assertEquals(MailBodyPhase.LOADING, vm.message("e3").bodyPhase)
        vm.close()
    }

    @Test fun `opening a remote message fetches it once and a stored one is never fetched`() = runTest(dispatcher) {
        val mail = repository()
        val vm = viewModel(mail)
        runCurrent()
        vm.onAction(MailThreadAction.ToggleMessage("e1"))
        assertEquals(MailBodyPhase.LOADING, vm.message("e1").bodyPhase)
        runCurrent()
        vm.onAction(MailThreadAction.ToggleMessage("e1"))
        vm.onAction(MailThreadAction.ToggleMessage("e1"))
        vm.onAction(MailThreadAction.ToggleMessage("e2"))
        vm.onAction(MailThreadAction.LoadBody("e2"))
        runCurrent()
        assertEquals(listOf("e3", "e1"), mail.contents.asked)
        assertEquals(MailBodyPhase.READY, vm.message("e1").bodyPhase)
        vm.close()
    }

    @Test fun `a failed fetch says why and loading it again shows the body`() = runTest(dispatcher) {
        val cases = listOf(
            mailUnavailable<MailMessageContent>(MailContentUnavailable.PROVIDER_UNREACHABLE) to
                (FailureKind.UNAVAILABLE to MailContentUnavailable.PROVIDER_UNREACHABLE),
            mailUnavailable<MailMessageContent>(MailContentUnavailable.RATE_LIMITED) to
                (FailureKind.UNAVAILABLE to MailContentUnavailable.RATE_LIMITED),
            mailFailure<MailContentOutcome<MailMessageContent>>(FailureKind.NOT_FOUND) to
                (FailureKind.NOT_FOUND to null),
            crashes<MailContentOutcome<MailMessageContent>>() to (null to null),
        )
        for ((failing, expected) in cases) {
            val mail = repository(failing, mailFetched(MailMessageContent("e3", "Celý text")))
            val vm = viewModel(mail)
            runCurrent()
            val failed = vm.message("e3")
            assertEquals(MailBodyPhase.FAILED, failed.bodyPhase, "$expected")
            assertEquals(expected, failed.bodyFailure to failed.bodyUnavailable)
            assertEquals(MailThreadPhase.CONTENT, vm.state.value.phase)
            vm.onAction(MailThreadAction.LoadBody("e3"))
            runCurrent()
            assertEquals(MailBodyPhase.READY, vm.message("e3").bodyPhase, "$expected")
            assertNull(vm.message("e3").bodyUnavailable)
            assertEquals(2, mail.contents.count)
            vm.close()
        }
    }

    @Test fun `a fetched body stays when a reload still finds the message remote`() = runTest(dispatcher) {
        val mail = repository()
        val vm = viewModel(mail)
        runCurrent()
        vm.onAction(MailThreadAction.Refresh)
        runCurrent()
        assertEquals(2, mail.thread.count)
        assertEquals(1, mail.contents.count)
        assertEquals("Celý text", vm.message("e3").bodyText)
        vm.close()
    }

    @Test fun `closing ends a fetch in flight without a failure`() = runTest(dispatcher) {
        val mail = repository(neverAnswers())
        val vm = viewModel(mail)
        runCurrent()
        vm.close()
        runCurrent()
        assertEquals(1, mail.contents.cancellations)
        assertEquals(MailBodyPhase.LOADING, vm.message("e3").bodyPhase)
    }

    @Test fun `saving an attachment shows its progress and then opens its Files item`() = runTest(dispatcher) {
        val mail = repository()
        val vm = viewModel(mail)
        val effects = collectEffects(vm)
        runCurrent()
        assertEquals(MailAttachmentSavePhase.IDLE, vm.file("a1").savePhase)
        assertNull(vm.file("a1").fileItemId)
        assertEquals("f2", vm.file("a2").fileItemId)
        vm.onAction(MailThreadAction.SaveAttachment("e3", "a1"))
        vm.onAction(MailThreadAction.SaveAttachment("e3", "a1"))
        assertEquals(MailAttachmentSavePhase.SAVING, vm.file("a1").savePhase)
        runCurrent()
        assertEquals(listOf("e3" to "a1"), mail.saves.asked)
        assertEquals(MailAttachmentSavePhase.SAVED, vm.file("a1").savePhase)
        assertEquals("f9", vm.file("a1").fileItemId)
        vm.onAction(MailThreadAction.Open(MailThreadTarget.File("f9")))
        runCurrent()
        assertEquals(listOf<MailThreadEffect>(MailThreadEffect.OpenFile("f9")), effects)
        vm.close()
    }

    @Test fun `a failed save says why and can be tried again`() = runTest(dispatcher) {
        val mail = ScriptedMailRepository(
            thread = MailCall(mailContent(remoteThread)),
            saves = MailCall(mailUnavailable(MailContentUnavailable.ATTACHMENT_TOO_LARGE), mailFetched("f9")),
        )
        val vm = viewModel(mail)
        runCurrent()
        vm.onAction(MailThreadAction.SaveAttachment("e3", "a1"))
        runCurrent()
        assertEquals(MailAttachmentSavePhase.FAILED, vm.file("a1").savePhase)
        assertEquals(MailContentUnavailable.ATTACHMENT_TOO_LARGE, vm.file("a1").saveUnavailable)
        assertEquals(FailureKind.UNAVAILABLE, vm.file("a1").saveFailure)
        assertNull(vm.file("a1").fileItemId)
        vm.onAction(MailThreadAction.SaveAttachment("e3", "a1"))
        runCurrent()
        assertEquals(MailAttachmentSavePhase.SAVED, vm.file("a1").savePhase)
        assertNull(vm.file("a1").saveUnavailable)
        vm.close()
    }

    @Test fun `a saved attachment keeps its Files item across a reload and an unknown one is not saved`() =
        runTest(dispatcher) {
            val mail = repository()
            val vm = viewModel(mail)
            runCurrent()
            vm.onAction(MailThreadAction.SaveAttachment("e3", "a1"))
            vm.onAction(MailThreadAction.SaveAttachment("e3", "gone"))
            vm.onAction(MailThreadAction.SaveAttachment("e1", "a1"))
            runCurrent()
            vm.onAction(MailThreadAction.Refresh)
            runCurrent()
            assertEquals(listOf("e3" to "a1"), mail.saves.asked)
            assertEquals("f9", vm.file("a1").fileItemId)
            assertTrue(vm.state.value.messages.all { it.attachments.isEmpty() || it.emailId == "e3" })
            vm.close()
        }
}
