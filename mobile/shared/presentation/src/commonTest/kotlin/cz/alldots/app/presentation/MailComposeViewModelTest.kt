package cz.alldots.app.presentation

import androidx.lifecycle.ViewModelStore
import cz.alldots.app.core.FailureKind
import cz.alldots.app.core.MailRefusal
import cz.alldots.app.domain.MailAddress
import cz.alldots.app.domain.MailDraftMode
import cz.alldots.app.domain.MailOutcome
import cz.alldots.app.domain.MailPrefill
import cz.alldots.app.domain.MailSentDraft
import cz.alldots.app.domain.RepositoryResult
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

private val SENT = MailSentDraft("d1", "t1", "Gmail")

/** A send whose draft write or send [drafts] refuses for [reason], after [sends] calls of the send itself. */
private class RefusedSend(
    val start: MailComposeStart,
    val drafts: ScriptedMailDraftRepository,
    val reason: MailRefusal,
    val sends: Int,
)

@OptIn(ExperimentalCoroutinesApi::class)
class MailComposeViewModelTest : MainDispatcherTest() {
    private fun viewModel(
        start: MailComposeStart = MailComposeStart.New,
        drafts: ScriptedMailDraftRepository = ScriptedMailDraftRepository(),
        mailboxes: ScriptedMailboxRepository = ScriptedMailboxRepository(),
    ) = ScriptedMailRepository().let { MailViewModelFactory(it, it, drafts, mailboxes, it, it) }.composeViewModel(start)

    private val reply = MailComposeStart.Reply("e3", "m1", MailReplyMode.REPLY_ALL)

    @Test fun `a new message starts blank from the first account`() = runTest(dispatcher) {
        val vm = viewModel()
        assertEquals(MailComposePhase.LOADING, vm.state.value.phase)
        runCurrent()
        val state = vm.state.value
        assertEquals(MailComposePhase.EDITING, state.phase)
        assertEquals(listOf(MailSender("m1", "Gmail", "me@gmail.com")), state.senders)
        assertEquals("m1", state.senderId)
        assertEquals(emptyList(), state.to)
        assertEquals("", state.initialBody)
        vm.close()
    }

    @Test fun `a reply is a draft the server wrote and carries its quote`() = runTest(dispatcher) {
        val drafts = ScriptedMailDraftRepository(
            prefilled = MailCall(mailDone(mailDraft(mode = MailDraftMode.REPLY, body = "> citace"))),
        )
        val vm = viewModel(reply, drafts)
        runCurrent()
        assertEquals(listOf(MailPrefill("m1", MailDraftMode.REPLY_ALL, "e3", "")), drafts.prefilled.asked)
        val state = vm.state.value
        assertEquals(listOf(MailRecipient("Petr", "petr@novak.cz")), state.to)
        assertEquals("Re: Nabídka", state.initialSubject)
        assertEquals("> citace", state.initialBody)
        vm.close()
    }

    @Test fun `every reply mode asks for its own draft`() = runTest(dispatcher) {
        val modes = mapOf(
            MailReplyMode.REPLY to MailDraftMode.REPLY,
            MailReplyMode.REPLY_ALL to MailDraftMode.REPLY_ALL,
            MailReplyMode.FORWARD to MailDraftMode.FORWARD,
        )
        modes.forEach { (mode, expected) ->
            val drafts = ScriptedMailDraftRepository()
            viewModel(MailComposeStart.Reply("e3", "m1", mode), drafts).also {
                runCurrent()
                assertEquals(expected, drafts.prefilled.asked.single().mode)
                it.close()
            }
        }
    }

    @Test fun `a saved draft opens as it was written`() = runTest(dispatcher) {
        val drafts = ScriptedMailDraftRepository()
        val vm = viewModel(MailComposeStart.Draft("d1"), drafts)
        runCurrent()
        assertEquals(listOf("d1"), drafts.read.asked)
        assertEquals("Dobrý den", vm.state.value.initialBody)
        vm.close()
    }

    @Test fun `a draft of a mailbox the list lacks still names its sender`() = runTest(dispatcher) {
        val boxes = ScriptedMailboxRepository(list = MailCall(mailContent(emptyList())))
        val vm = viewModel(MailComposeStart.Draft("d1"), mailboxes = boxes)
        runCurrent()
        assertEquals(listOf(MailSender("m1", "me@gmail.com", "me@gmail.com")), vm.state.value.senders)
        vm.close()
    }

    @Test fun `failing accounts or draft are an error and retry recovers`() = runTest(dispatcher) {
        val boxes =
            ScriptedMailboxRepository(list = MailCall(mailFailure(FailureKind.UNAVAILABLE), mailContent(emptyList())))
        val vm = viewModel(mailboxes = boxes)
        runCurrent()
        assertEquals(MailComposePhase.ERROR, vm.state.value.phase)
        assertEquals(FailureKind.UNAVAILABLE, vm.state.value.failure)
        vm.onAction(MailComposeAction.Retry)
        runCurrent()
        assertEquals(MailComposePhase.EDITING, vm.state.value.phase)
        val broken = viewModel(
            MailComposeStart.Draft("gone"),
            ScriptedMailDraftRepository(read = MailCall(mailFailure(FailureKind.NOT_FOUND))),
        )
        val crashed = viewModel(mailboxes = ScriptedMailboxRepository(list = MailCall(crashes())))
        runCurrent()
        assertEquals(FailureKind.NOT_FOUND, broken.state.value.failure)
        assertNull(crashed.state.value.failure)
        assertEquals(MailComposePhase.ERROR, crashed.state.value.phase)
        vm.close()
        broken.close()
        crashed.close()
    }

    @Test fun `recipients are suggested after a pause and chosen once`() = runTest(dispatcher) {
        val drafts = ScriptedMailDraftRepository()
        val vm = viewModel(drafts = drafts)
        runCurrent()
        vm.onAction(MailComposeAction.SearchContacts(" pet "))
        advanceTimeBy(100)
        runCurrent()
        assertEquals(0, drafts.contacts.count)
        advanceTimeBy(200)
        runCurrent()
        assertEquals(listOf("pet" to emptyList<String>()), drafts.contacts.asked)
        assertEquals(listOf(MailSuggestion("Petr Novák", "petr@novak.cz", "Klient")), vm.state.value.suggestions)
        vm.onAction(MailComposeAction.AddRecipient("Petr Novák", "petr@novak.cz"))
        vm.onAction(MailComposeAction.AddRecipient("Petr Novák", "PETR@novak.cz"))
        assertEquals(listOf(MailRecipient("Petr Novák", "petr@novak.cz")), vm.state.value.to)
        assertEquals(emptyList(), vm.state.value.suggestions)
        vm.onAction(MailComposeAction.SearchContacts("a"))
        advanceTimeBy(300)
        runCurrent()
        assertEquals(listOf("petr@novak.cz"), drafts.contacts.asked.last().second)
        vm.close()
    }

    @Test fun `blank text clears the suggestions and a failed search shows none`() = runTest(dispatcher) {
        val drafts = ScriptedMailDraftRepository(contacts = MailCall(mailFailure(FailureKind.UNAVAILABLE)))
        val vm = viewModel(drafts = drafts)
        runCurrent()
        vm.onAction(MailComposeAction.SearchContacts("a"))
        advanceTimeBy(300)
        runCurrent()
        assertEquals(emptyList(), vm.state.value.suggestions)
        vm.onAction(MailComposeAction.SearchContacts("  "))
        assertEquals(1, drafts.contacts.count)
        vm.close()
    }

    @Test fun `a typed address is added and anything else is invalid until one is`() = runTest(dispatcher) {
        val vm = viewModel()
        runCurrent()
        vm.onAction(MailComposeAction.AddAddress("no address"))
        assertTrue(vm.state.value.invalidAddress)
        assertEquals(emptyList(), vm.state.value.to)
        vm.onAction(MailComposeAction.AddAddress(" new@x.cz "))
        assertFalse(vm.state.value.invalidAddress)
        assertEquals(listOf(MailRecipient("", "new@x.cz")), vm.state.value.to)
        vm.onAction(MailComposeAction.RemoveRecipient("new@x.cz"))
        assertEquals(emptyList(), vm.state.value.to)
        vm.close()
    }

    @Test fun `removing a recipient removes it from the copy line too and the sender can change`() =
        runTest(dispatcher) {
            val vm = viewModel(MailComposeStart.Draft("d1"))
            runCurrent()
            vm.onAction(MailComposeAction.SelectSender("m2"))
            assertEquals("m2", vm.state.value.senderId)
            vm.onAction(MailComposeAction.RemoveRecipient("petr@novak.cz"))
            assertEquals(emptyList(), vm.state.value.to)
            vm.close()
        }

    @Test fun `sending a new message makes the draft and sends it as the person`() = runTest(dispatcher) {
        val drafts = ScriptedMailDraftRepository()
        val vm = viewModel(drafts = drafts)
        runCurrent()
        vm.onAction(MailComposeAction.Send("x", "y"))
        assertEquals(0, drafts.create.count)
        vm.onAction(MailComposeAction.AddAddress("petr@novak.cz"))
        vm.onAction(MailComposeAction.Send("Předmět", "Text"))
        assertEquals(MailSendPhase.SENDING, vm.state.value.sendPhase)
        vm.onAction(MailComposeAction.Send("Předmět", "Text"))
        runCurrent()
        val (fields, thread) = drafts.create.asked.single()
        assertEquals(MailAddress("", "petr@novak.cz"), fields.to.single())
        assertEquals("me@gmail.com", fields.from)
        assertEquals("Předmět", fields.subject)
        assertEquals("Text", fields.body)
        assertNull(thread)
        assertEquals(listOf("d1"), drafts.send.asked)
        assertEquals(MailSendPhase.SENT, vm.state.value.sendPhase)
        assertEquals("Gmail", vm.state.value.sentFrom)
        vm.close()
    }

    @Test fun `a reply is saved with the version and the hidden copy it came with`() = runTest(dispatcher) {
        val drafts = ScriptedMailDraftRepository()
        val vm = viewModel(reply, drafts)
        runCurrent()
        vm.onAction(MailComposeAction.Send("Re: Nabídka", "Nový text"))
        runCurrent()
        val (id, version, fields) = drafts.update.asked.single()
        assertEquals("d1", id)
        assertEquals("v1", version)
        assertEquals("hidden@x.cz", fields.bcc.single().address)
        assertEquals(0, drafts.create.count)
        assertEquals(listOf("d1"), drafts.send.asked)
        vm.close()
    }

    @Test fun `a failed send keeps the draft and the next send updates and sends it`() = runTest(dispatcher) {
        val drafts = ScriptedMailDraftRepository(
            send = MailCall(mailFailure(FailureKind.REJECTED), mailDone(SENT)),
        )
        val vm = viewModel(drafts = drafts)
        runCurrent()
        vm.onAction(MailComposeAction.AddAddress("petr@novak.cz"))
        vm.onAction(MailComposeAction.Send("A", "B"))
        runCurrent()
        assertEquals(MailSendPhase.FAILED, vm.state.value.sendPhase)
        assertEquals(FailureKind.REJECTED, vm.state.value.sendFailure)
        vm.onAction(MailComposeAction.Send("A", "B2"))
        runCurrent()
        assertEquals(1, drafts.create.count)
        assertEquals("B2", drafts.update.asked.single().third.body)
        assertEquals(MailSendPhase.SENT, vm.state.value.sendPhase)
        vm.close()
    }

    @Test fun `a refused save or create fails the send without sending`() = runTest(dispatcher) {
        val refusedCreate = ScriptedMailDraftRepository(create = MailCall(mailFailure(FailureKind.REJECTED)))
        val crashedUpdate = ScriptedMailDraftRepository(update = MailCall(crashes()))
        val first = viewModel(drafts = refusedCreate)
        val second = viewModel(reply, crashedUpdate)
        runCurrent()
        first.onAction(MailComposeAction.AddAddress("a@x.cz"))
        first.onAction(MailComposeAction.Send("A", "B"))
        second.onAction(MailComposeAction.Send("A", "B"))
        runCurrent()
        assertEquals(FailureKind.REJECTED, first.state.value.sendFailure)
        assertEquals(MailSendPhase.FAILED, second.state.value.sendPhase)
        assertNull(second.state.value.sendFailure)
        assertEquals(0, refusedCreate.send.count)
        assertEquals(0, crashedUpdate.send.count)
        first.close()
        second.close()
    }

    @Test fun `a refused draft or send says why and sends nothing more`() = runTest(dispatcher) {
        val cases = listOf(
            RefusedSend(
                MailComposeStart.New,
                ScriptedMailDraftRepository(create = MailCall(mailRefused(MailRefusal.DRAFTS_FOLDER_MISSING))),
                MailRefusal.DRAFTS_FOLDER_MISSING,
                sends = 0,
            ),
            RefusedSend(
                reply,
                ScriptedMailDraftRepository(update = MailCall(mailRefused(MailRefusal.DRAFT_ALREADY_SENT))),
                MailRefusal.DRAFT_ALREADY_SENT,
                sends = 0,
            ),
            RefusedSend(
                MailComposeStart.New,
                ScriptedMailDraftRepository(send = MailCall(mailRefused(MailRefusal.SENT_FOLDER_MISSING))),
                MailRefusal.SENT_FOLDER_MISSING,
                sends = 1,
            ),
            RefusedSend(
                MailComposeStart.New,
                ScriptedMailDraftRepository(send = MailCall(mailRefused(MailRefusal.RECIPIENT_REJECTED))),
                MailRefusal.RECIPIENT_REJECTED,
                sends = 1,
            ),
        )
        for (case in cases) {
            val vm = viewModel(case.start, case.drafts)
            runCurrent()
            vm.onAction(MailComposeAction.AddAddress("petr@novak.cz"))
            vm.onAction(MailComposeAction.Send("A", "B"))
            runCurrent()
            val state = vm.state.value
            assertEquals(MailSendPhase.FAILED, state.sendPhase, "${case.reason}")
            assertEquals(FailureKind.REJECTED, state.sendFailure, "${case.reason}")
            assertEquals(case.reason, state.sendRefusal)
            assertEquals(case.sends, case.drafts.send.count, "${case.reason}")
            vm.close()
        }
    }

    @Test fun `sending again clears the reason the server gave`() = runTest(dispatcher) {
        val drafts = ScriptedMailDraftRepository(
            create = MailCall(mailRefused(MailRefusal.DRAFTS_FOLDER_MISSING), mailDone(mailDraft())),
        )
        val vm = viewModel(drafts = drafts)
        runCurrent()
        vm.onAction(MailComposeAction.AddAddress("petr@novak.cz"))
        vm.onAction(MailComposeAction.Send("A", "B"))
        runCurrent()
        assertEquals(MailRefusal.DRAFTS_FOLDER_MISSING, vm.state.value.sendRefusal)
        vm.onAction(MailComposeAction.Send("A", "B"))
        assertNull(vm.state.value.sendRefusal)
        assertNull(vm.state.value.sendFailure)
        runCurrent()
        assertEquals(MailSendPhase.SENT, vm.state.value.sendPhase)
        assertNull(vm.state.value.sendRefusal)
        vm.close()
    }

    @Test fun `a reply in a mailbox without Drafts is an error that says why and retry clears it`() =
        runTest(dispatcher) {
            val drafts = ScriptedMailDraftRepository(
                prefilled = MailCall(
                    mailRefused(MailRefusal.DRAFTS_FOLDER_MISSING),
                    mailDone(mailDraft(mode = MailDraftMode.REPLY)),
                ),
            )
            val vm = viewModel(reply, drafts)
            runCurrent()
            assertEquals(MailComposePhase.ERROR, vm.state.value.phase)
            assertEquals(FailureKind.REJECTED, vm.state.value.failure)
            assertEquals(MailRefusal.DRAFTS_FOLDER_MISSING, vm.state.value.refusal)
            vm.onAction(MailComposeAction.Retry)
            runCurrent()
            assertEquals(MailComposePhase.EDITING, vm.state.value.phase)
            assertNull(vm.state.value.refusal)
            vm.close()
        }

    @Test fun `leaving a message nobody made a draft for closes at once`() = runTest(dispatcher) {
        val drafts = ScriptedMailDraftRepository()
        val vm = viewModel(drafts = drafts)
        val effects = collectEffects(vm)
        runCurrent()
        vm.onAction(MailComposeAction.Cancel)
        runCurrent()
        assertEquals(listOf<MailComposeEffect>(MailComposeEffect.Close), effects)
        assertEquals(0, drafts.discard.count)
        vm.close()
    }

    @Test fun `leaving a reply discards the draft that was made for it`() = runTest(dispatcher) {
        val drafts = ScriptedMailDraftRepository()
        val vm = viewModel(reply, drafts)
        val effects = collectEffects(vm)
        runCurrent()
        vm.onAction(MailComposeAction.Cancel)
        runCurrent()
        assertEquals(listOf("d1"), drafts.discard.asked)
        assertEquals(listOf<MailComposeEffect>(MailComposeEffect.Close), effects)
        vm.close()
    }

    @Test fun `leaving Semps draft or a sent message keeps the draft`() = runTest(dispatcher) {
        val semp = ScriptedMailDraftRepository()
        val sent = ScriptedMailDraftRepository()
        val first = viewModel(MailComposeStart.Draft("d1"), semp)
        val second = viewModel(reply, sent)
        runCurrent()
        second.onAction(MailComposeAction.Send("A", "B"))
        runCurrent()
        first.onAction(MailComposeAction.Cancel)
        second.onAction(MailComposeAction.Cancel)
        runCurrent()
        assertEquals(0, semp.discard.count)
        assertEquals(0, sent.discard.count)
        first.close()
        second.close()
    }

    @Test fun `a draft that cannot be discarded keeps the screen and leaving again closes it`() = runTest(dispatcher) {
        val drafts = ScriptedMailDraftRepository(discard = MailCall(mailFailure(FailureKind.UNAVAILABLE)))
        val vm = viewModel(reply, drafts)
        val effects = collectEffects(vm)
        runCurrent()
        vm.onAction(MailComposeAction.Cancel)
        runCurrent()
        assertTrue(vm.state.value.discardFailed)
        assertEquals(emptyList(), effects)
        vm.onAction(MailComposeAction.Cancel)
        runCurrent()
        assertEquals(listOf<MailComposeEffect>(MailComposeEffect.Close), effects)
        assertEquals(1, drafts.discard.count)
        vm.close()
    }

    @Test fun `close cancels in flight work and a closed ViewModel ignores actions`() = runTest(dispatcher) {
        val drafts = ScriptedMailDraftRepository(prefilled = MailCall(neverAnswers()))
        val vm = viewModel(reply, drafts)
        runCurrent()
        vm.close()
        vm.close()
        runCurrent()
        vm.onAction(MailComposeAction.Retry)
        vm.onAction(MailComposeAction.AddAddress("a@x.cz"))
        runCurrent()
        assertTrue(vm.isClosed)
        assertEquals(1, drafts.prefilled.cancellations)
        assertEquals(1, drafts.prefilled.count)
        assertEquals(emptyList(), vm.state.value.to)
        assertEquals(emptyList(), vm.effects.toList())
    }

    @Test fun `a draft that answers late after close never publishes`() = runTest(dispatcher) {
        val gate = CompletableDeferred<Unit>()
        val drafts = ScriptedMailDraftRepository(
            prefilled = MailCall(answersLate(gate, RepositoryResult.Content(MailOutcome.Done(mailDraft())))),
        )
        val vm = viewModel(reply, drafts)
        runCurrent()
        vm.close()
        gate.complete(Unit)
        runCurrent()
        assertEquals(MailComposePhase.LOADING, vm.state.value.phase)
    }

    @Test fun `clearing the owning store ends it like close`() = runTest(dispatcher) {
        val store = ViewModelStore()
        val drafts = ScriptedMailDraftRepository(read = MailCall(neverAnswers()))
        val vm = store.provide { viewModel(MailComposeStart.Draft("d1"), drafts) }
        runCurrent()
        store.clear()
        runCurrent()
        assertTrue(vm.isClosed)
        assertEquals(1, drafts.read.cancellations)
    }
}
