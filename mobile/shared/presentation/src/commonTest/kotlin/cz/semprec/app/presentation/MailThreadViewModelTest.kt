package cz.semprec.app.presentation

import androidx.lifecycle.ViewModelStore
import cz.semprec.app.core.FailureKind
import cz.semprec.app.core.MailRefusal
import cz.semprec.app.domain.MailLink
import cz.semprec.app.domain.MailLinkKind
import cz.semprec.app.domain.MailNamedRef
import cz.semprec.app.domain.MailSentDraft
import cz.semprec.app.domain.MailThreadTask
import cz.semprec.app.domain.RepositoryResult
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

@OptIn(ExperimentalCoroutinesApi::class)
class MailThreadViewModelTest : MainDispatcherTest() {
    private fun viewModel(
        mail: ScriptedMailRepository = ScriptedMailRepository(),
        drafts: ScriptedMailDraftRepository = ScriptedMailDraftRepository(),
    ) = MailViewModelFactory(mail, mail, drafts, ScriptedMailboxRepository(), mail).threadViewModel("t1")

    private val withDraft = mailDetail(
        messages = listOf(
            mailMessage("e1"),
            mailMessage("e2", own = true, purpose = "sent"),
            mailMessage("dr", purpose = "drafts"),
        ),
    )

    @Test fun `shows the thread with the last message open and the drafts left out of the messages`() =
        runTest(dispatcher) {
            val vm = viewModel(ScriptedMailRepository(thread = MailCall(mailContent(withDraft))))
            runCurrent()
            val state = vm.state.value
            assertEquals(MailThreadPhase.CONTENT, state.phase)
            assertEquals("Re: Nabídka", state.subject)
            assertEquals("Petr Novák", state.senderName)
            assertEquals("Web", state.project.text)
            assertEquals(listOf("e1", "e2"), state.messages.map { it.emailId })
            assertEquals(listOf(false, true), state.messages.map { it.expanded })
            assertEquals(listOf("me@x.cz"), state.messages.first().toNames)
            assertTrue(state.canReply)
            assertFalse(state.archivedOrTrashed)
            vm.close()
        }

    @Test fun `a draft Semp made is offered as the reply`() = runTest(dispatcher) {
        val drafts = ScriptedMailDraftRepository(read = MailCall(mailContent(mailDraft(body = "Dobrý den"))))
        val vm = viewModel(ScriptedMailRepository(thread = MailCall(mailContent(withDraft))), drafts)
        runCurrent()
        assertEquals(MailSempDraft("d1", "Dobrý den", listOf("Petr")), vm.state.value.draft)
        assertEquals(listOf("dr"), drafts.read.asked)
        vm.close()
    }

    @Test fun `a draft the person wrote is not offered and one that cannot be read leaves no card`() =
        runTest(dispatcher) {
            val own = ScriptedMailDraftRepository(read = MailCall(mailContent(mailDraft(agent = false))))
            val first = viewModel(ScriptedMailRepository(thread = MailCall(mailContent(withDraft))), own)
            val broken = ScriptedMailDraftRepository(read = MailCall(mailFailure(FailureKind.NOT_FOUND)))
            val second = viewModel(ScriptedMailRepository(thread = MailCall(mailContent(withDraft))), broken)
            runCurrent()
            assertNull(first.state.value.draft)
            assertNull(second.state.value.draft)
            assertEquals(MailThreadPhase.CONTENT, second.state.value.phase)
            first.close()
            second.close()
        }

    @Test fun `opening an unread thread reads it and a read one is left alone`() = runTest(dispatcher) {
        val unread = ScriptedMailRepository(thread = MailCall(mailContent(mailDetail(unread = true))))
        val read = ScriptedMailRepository()
        val first = viewModel(unread)
        val second = viewModel(read)
        runCurrent()
        assertEquals(listOf("t1" to true), unread.read.asked)
        assertEquals(0, read.read.count)
        first.close()
        second.close()
    }

    @Test fun `a thread only in the archive or the trash offers to be restored`() = runTest(dispatcher) {
        val detail =
            mailDetail(messages = listOf(mailMessage("e1", purpose = "archive"), mailMessage("e2", purpose = "trash")))
        val vm = viewModel(ScriptedMailRepository(thread = MailCall(mailContent(detail))))
        runCurrent()
        assertTrue(vm.state.value.archivedOrTrashed)
        vm.close()
    }

    @Test fun `a thread whose messages have no mailbox cannot be replied to`() = runTest(dispatcher) {
        val detail = mailDetail(messages = listOf(mailMessage("e1", mailboxId = null)))
        val vm = viewModel(ScriptedMailRepository(thread = MailCall(mailContent(detail))))
        runCurrent()
        assertFalse(vm.state.value.canReply)
        val effects = collectEffects(vm)
        vm.onAction(MailThreadAction.Open(MailThreadTarget.Reply(MailReplyMode.REPLY)))
        runCurrent()
        assertEquals(emptyList(), effects)
        vm.close()
    }

    @Test fun `the tasks of the thread carry their projects people and links`() = runTest(dispatcher) {
        val link = MailLink(MailLinkKind.INHERITED, listOf("Web"), null)
        val task = MailThreadTask("k1", "Poslat nabídku", "2026-10-23", "done", "Web", link, listOf("Petr"), null)
        val vm =
            viewModel(ScriptedMailRepository(thread = MailCall(mailContent(mailDetail().copy(tasks = listOf(task))))))
        runCurrent()
        val shown = vm.state.value.tasks.single()
        assertTrue(shown.done)
        assertEquals("Web", shown.project.text)
        assertEquals(MailLinkType.INHERITED, shown.project.link?.type)
        assertEquals(listOf("Petr"), shown.peopleNames)
        assertNull(shown.peopleLink)
        vm.close()
    }

    @Test fun `a message opens and closes without a request`() = runTest(dispatcher) {
        val mail = ScriptedMailRepository()
        val vm = viewModel(mail)
        runCurrent()
        vm.onAction(MailThreadAction.ToggleMessage("e1"))
        assertEquals(listOf(true, false, true), vm.state.value.messages.map { it.expanded })
        vm.onAction(MailThreadAction.ToggleMessage("e3"))
        assertEquals(listOf(true, false, false), vm.state.value.messages.map { it.expanded })
        assertEquals(1, mail.thread.count)
        vm.close()
    }

    @Test fun `an error shows its kind and retry loads again`() = runTest(dispatcher) {
        val mail =
            ScriptedMailRepository(thread = MailCall(mailFailure(FailureKind.NOT_FOUND), mailContent(mailDetail())))
        val vm = viewModel(mail)
        runCurrent()
        assertEquals(MailThreadPhase.ERROR, vm.state.value.phase)
        assertEquals(FailureKind.NOT_FOUND, vm.state.value.failure)
        vm.onAction(MailThreadAction.Retry)
        runCurrent()
        assertEquals(MailThreadPhase.CONTENT, vm.state.value.phase)
        vm.close()
    }

    @Test fun `an unexpected exception is an error without a kind and a failed refresh keeps the thread`() =
        runTest(dispatcher) {
            val crashed = viewModel(ScriptedMailRepository(thread = MailCall(crashes())))
            val refreshed = viewModel(
                ScriptedMailRepository(
                    thread = MailCall(mailContent(mailDetail()), mailFailure(FailureKind.UNAVAILABLE)),
                ),
            )
            runCurrent()
            assertEquals(MailThreadPhase.ERROR, crashed.state.value.phase)
            assertNull(crashed.state.value.failure)
            refreshed.onAction(MailThreadAction.Refresh)
            assertTrue(refreshed.state.value.refreshing)
            runCurrent()
            assertEquals(MailThreadPhase.CONTENT, refreshed.state.value.phase)
            assertTrue(refreshed.state.value.actionFailed)
            refreshed.onAction(MailThreadAction.DismissFailure)
            assertFalse(refreshed.state.value.actionFailed)
            crashed.close()
            refreshed.close()
        }

    @Test fun `flagging shows at once and takes the answer of the server`() = runTest(dispatcher) {
        val mail = ScriptedMailRepository(flag = MailCall(mailDone(true)))
        val vm = viewModel(mail)
        runCurrent()
        vm.onAction(MailThreadAction.ToggleFlag)
        assertTrue(vm.state.value.flagged)
        runCurrent()
        assertTrue(vm.state.value.flagged)
        assertEquals(listOf("t1" to true), mail.flag.asked)
        vm.close()
    }

    @Test fun `a refused flag is taken back`() = runTest(dispatcher) {
        val mail = ScriptedMailRepository(flag = MailCall(mailFailure(FailureKind.REJECTED)))
        val vm = viewModel(mail)
        runCurrent()
        vm.onAction(MailThreadAction.ToggleFlag)
        runCurrent()
        assertFalse(vm.state.value.flagged)
        assertTrue(vm.state.value.actionFailed)
        vm.close()
    }

    @Test fun `a flag refused for a thread without a received message says why until dismissed`() =
        runTest(dispatcher) {
            val mail = ScriptedMailRepository(flag = MailCall(mailRefused(MailRefusal.NO_RECEIVED_MESSAGE)))
            val vm = viewModel(mail)
            runCurrent()
            vm.onAction(MailThreadAction.ToggleFlag)
            runCurrent()
            assertFalse(vm.state.value.flagged)
            assertTrue(vm.state.value.actionFailed)
            assertEquals(MailRefusal.NO_RECEIVED_MESSAGE, vm.state.value.actionRefusal)
            vm.onAction(MailThreadAction.DismissFailure)
            assertFalse(vm.state.value.actionFailed)
            assertNull(vm.state.value.actionRefusal)
            vm.close()
        }

    @Test fun `a move refused for a known reason stays on the thread and says why`() = runTest(dispatcher) {
        val cases = listOf(
            MailThreadMove.ARCHIVE to MailRefusal.ARCHIVE_FOLDER_MISSING,
            MailThreadMove.TRASH to MailRefusal.ALREADY_TRASHED,
            MailThreadMove.TRASH to MailRefusal.MOVE_SOURCE_UNVERIFIED,
            MailThreadMove.RESTORE to MailRefusal.SENT_FOLDER_MISSING,
        )
        for ((move, refusal) in cases) {
            val mail = ScriptedMailRepository(moves = MailCall(mailRefused(refusal)))
            val vm = viewModel(mail)
            val effects = collectEffects(vm)
            runCurrent()
            vm.onAction(MailThreadAction.Move(move))
            runCurrent()
            assertTrue(vm.state.value.actionFailed, "$refusal")
            assertEquals(refusal, vm.state.value.actionRefusal)
            assertEquals(1, mail.thread.count, "$refusal")
            assertEquals(emptyList(), effects, "$refusal")
            vm.close()
        }
    }

    @Test fun `a failure without a reason after a refused move shows no old reason`() = runTest(dispatcher) {
        val mail = ScriptedMailRepository(
            moves = MailCall(mailRefused(MailRefusal.TRASH_FOLDER_MISSING)),
            tasks = MailCall(mailFailure(FailureKind.UNAVAILABLE)),
        )
        val vm = viewModel(mail)
        runCurrent()
        vm.onAction(MailThreadAction.Move(MailThreadMove.TRASH))
        runCurrent()
        assertEquals(MailRefusal.TRASH_FOLDER_MISSING, vm.state.value.actionRefusal)
        vm.onAction(MailThreadAction.AddTask)
        runCurrent()
        assertTrue(vm.state.value.actionFailed)
        assertNull(vm.state.value.actionRefusal)
        vm.close()
    }

    @Test fun `archiving and trashing close the screen`() = runTest(dispatcher) {
        val mail = ScriptedMailRepository()
        val vm = viewModel(mail)
        val effects = collectEffects(vm)
        runCurrent()
        vm.onAction(MailThreadAction.Move(MailThreadMove.ARCHIVE))
        assertTrue(vm.state.value.acting)
        runCurrent()
        vm.onAction(MailThreadAction.Move(MailThreadMove.TRASH))
        runCurrent()
        assertEquals(listOf("archive:t1", "trash:t1"), mail.moved)
        assertEquals(listOf<MailThreadEffect>(MailThreadEffect.Close, MailThreadEffect.Close), effects)
        assertFalse(vm.state.value.acting)
        vm.close()
    }

    @Test fun `restoring loads the thread again and stays`() = runTest(dispatcher) {
        val mail = ScriptedMailRepository()
        val vm = viewModel(mail)
        val effects = collectEffects(vm)
        runCurrent()
        vm.onAction(MailThreadAction.Move(MailThreadMove.RESTORE))
        runCurrent()
        assertEquals(listOf("restore:t1"), mail.moved)
        assertEquals(2, mail.thread.count)
        assertEquals(emptyList(), effects)
        vm.close()
    }

    @Test fun `a refused move stays on the thread and says so and a second move waits`() = runTest(dispatcher) {
        val mail = ScriptedMailRepository(moves = MailCall(mailFailure(FailureKind.REJECTED)))
        val vm = viewModel(mail)
        val effects = collectEffects(vm)
        runCurrent()
        vm.onAction(MailThreadAction.Move(MailThreadMove.TRASH))
        vm.onAction(MailThreadAction.Move(MailThreadMove.ARCHIVE))
        runCurrent()
        assertEquals(listOf("trash:t1"), mail.moved)
        assertTrue(vm.state.value.actionFailed)
        assertFalse(vm.state.value.acting)
        assertEquals(emptyList(), effects)
        vm.close()
    }

    @Test fun `sending the unchanged draft sends it without saving`() = runTest(dispatcher) {
        val drafts = ScriptedMailDraftRepository()
        val mail = ScriptedMailRepository(thread = MailCall(mailContent(withDraft), mailContent(mailDetail())))
        val vm = viewModel(mail, drafts)
        runCurrent()
        vm.onAction(MailThreadAction.SendDraft("Dobrý den"))
        assertEquals(MailSendPhase.SENDING, vm.state.value.sendPhase)
        runCurrent()
        assertEquals(0, drafts.update.count)
        assertEquals(listOf("d1"), drafts.send.asked)
        assertEquals(MailSendPhase.SENT, vm.state.value.sendPhase)
        assertEquals("Gmail", vm.state.value.sentFrom)
        assertNull(vm.state.value.draft)
        vm.close()
    }

    @Test fun `sending a changed text saves it with the version first`() = runTest(dispatcher) {
        val drafts = ScriptedMailDraftRepository()
        val vm = viewModel(ScriptedMailRepository(thread = MailCall(mailContent(withDraft))), drafts)
        runCurrent()
        vm.onAction(MailThreadAction.SendDraft("Nový text"))
        runCurrent()
        val (id, version, fields) = drafts.update.asked.single()
        assertEquals("d1", id)
        assertEquals("v1", version)
        assertEquals("Nový text", fields.body)
        assertEquals("hidden@x.cz", fields.bcc.single().address)
        assertEquals(listOf("d1"), drafts.send.asked)
        vm.close()
    }

    @Test fun `a refused save does not send and a failed send can be tried again`() = runTest(dispatcher) {
        val drafts = ScriptedMailDraftRepository(
            update = MailCall(mailFailure(FailureKind.REJECTED)),
            send = MailCall(mailFailure(FailureKind.REJECTED), mailDone(MailSentDraft("d1", "t1", "Gmail"))),
        )
        val vm = viewModel(ScriptedMailRepository(thread = MailCall(mailContent(withDraft))), drafts)
        runCurrent()
        vm.onAction(MailThreadAction.SendDraft("Změněno"))
        runCurrent()
        assertEquals(MailSendPhase.FAILED, vm.state.value.sendPhase)
        assertEquals(FailureKind.REJECTED, vm.state.value.sendFailure)
        assertEquals(0, drafts.send.count)
        vm.onAction(MailThreadAction.SendDraft("Dobrý den"))
        runCurrent()
        vm.onAction(MailThreadAction.SendDraft("Dobrý den"))
        runCurrent()
        assertEquals(MailSendPhase.SENT, vm.state.value.sendPhase)
        assertEquals(2, drafts.send.count)
        vm.close()
    }

    @Test fun `a send refused for a missing Sent folder says why and sending again clears it`() =
        runTest(dispatcher) {
            val drafts = ScriptedMailDraftRepository(
                send = MailCall(
                    mailRefused(MailRefusal.SENT_FOLDER_MISSING),
                    mailDone(MailSentDraft("d1", "t1", "Gmail")),
                ),
            )
            val vm = viewModel(ScriptedMailRepository(thread = MailCall(mailContent(withDraft))), drafts)
            runCurrent()
            vm.onAction(MailThreadAction.SendDraft("Dobrý den"))
            runCurrent()
            assertEquals(MailSendPhase.FAILED, vm.state.value.sendPhase)
            assertEquals(FailureKind.REJECTED, vm.state.value.sendFailure)
            assertEquals(MailRefusal.SENT_FOLDER_MISSING, vm.state.value.sendRefusal)
            vm.onAction(MailThreadAction.SendDraft("Dobrý den"))
            assertNull(vm.state.value.sendRefusal)
            runCurrent()
            assertEquals(MailSendPhase.SENT, vm.state.value.sendPhase)
            vm.close()
        }

    @Test fun `a send that crashes fails without a kind and without a draft nothing is sent`() = runTest(dispatcher) {
        val drafts = ScriptedMailDraftRepository(send = MailCall(crashes()))
        val withSemp = viewModel(ScriptedMailRepository(thread = MailCall(mailContent(withDraft))), drafts)
        val without = viewModel()
        runCurrent()
        withSemp.onAction(MailThreadAction.SendDraft("Dobrý den"))
        without.onAction(MailThreadAction.SendDraft("x"))
        runCurrent()
        assertEquals(MailSendPhase.FAILED, withSemp.state.value.sendPhase)
        assertNull(withSemp.state.value.sendFailure)
        assertEquals(MailSendPhase.IDLE, without.state.value.sendPhase)
        withSemp.close()
        without.close()
    }

    @Test fun `editing and replying open the editor from the right message`() = runTest(dispatcher) {
        val vm = viewModel(ScriptedMailRepository(thread = MailCall(mailContent(withDraft))))
        val effects = collectEffects(vm)
        runCurrent()
        vm.onAction(MailThreadAction.Open(MailThreadTarget.Draft))
        vm.onAction(MailThreadAction.Open(MailThreadTarget.Reply(MailReplyMode.FORWARD)))
        vm.onAction(MailThreadAction.Open(MailThreadTarget.Task("k1")))
        runCurrent()
        assertEquals(
            listOf(
                MailThreadEffect.Compose(MailComposeStart.Draft("d1")),
                MailThreadEffect.Compose(MailComposeStart.Reply("e1", "m1", MailReplyMode.FORWARD)),
                MailThreadEffect.OpenTask("k1"),
            ),
            effects,
        )
        vm.close()
    }

    @Test fun `a task from the thread reloads it and a refused one says so`() = runTest(dispatcher) {
        val created = mailContent(MailNamedRef("t9", "x"))
        val mail = ScriptedMailRepository(tasks = MailCall(created, mailFailure(FailureKind.UNAVAILABLE)))
        val vm = viewModel(mail)
        runCurrent()
        vm.onAction(MailThreadAction.AddTask)
        assertTrue(vm.state.value.creatingTask)
        runCurrent()
        assertFalse(vm.state.value.creatingTask)
        assertEquals(2, mail.thread.count)
        vm.onAction(MailThreadAction.AddTask)
        runCurrent()
        assertTrue(vm.state.value.actionFailed)
        assertEquals(2, mail.thread.count)
        vm.close()
    }

    @Test fun `a thread without a draft reads no draft`() = runTest(dispatcher) {
        val drafts = ScriptedMailDraftRepository()
        val vm = viewModel(drafts = drafts)
        runCurrent()
        assertEquals(0, drafts.read.count)
        vm.close()
    }

    @Test fun `close cancels in flight work and a closed ViewModel ignores actions`() = runTest(dispatcher) {
        val mail = ScriptedMailRepository(thread = MailCall(neverAnswers()))
        val vm = viewModel(mail)
        runCurrent()
        vm.close()
        vm.close()
        runCurrent()
        vm.onAction(MailThreadAction.Retry)
        vm.onAction(MailThreadAction.ToggleFlag)
        vm.onAction(MailThreadAction.Open(MailThreadTarget.Task("k")))
        runCurrent()
        assertTrue(vm.isClosed)
        assertEquals(1, mail.thread.cancellations)
        assertEquals(1, mail.thread.count)
        assertEquals(0, mail.flag.count)
        assertEquals(emptyList(), vm.effects.toList())
    }

    @Test fun `a load that answers late after close never publishes`() = runTest(dispatcher) {
        val gate = CompletableDeferred<Unit>()
        val mail = ScriptedMailRepository(thread = MailCall(answersLate(gate, RepositoryResult.Content(mailDetail()))))
        val vm = viewModel(mail)
        runCurrent()
        vm.close()
        gate.complete(Unit)
        runCurrent()
        assertEquals(MailThreadPhase.LOADING, vm.state.value.phase)
    }

    @Test fun `clearing the owning store ends it like close`() = runTest(dispatcher) {
        val store = ViewModelStore()
        val mail = ScriptedMailRepository(thread = MailCall(neverAnswers()))
        val vm = store.provide { viewModel(mail) }
        runCurrent()
        store.clear()
        runCurrent()
        assertTrue(vm.isClosed)
        assertEquals(1, mail.thread.cancellations)
    }
}
