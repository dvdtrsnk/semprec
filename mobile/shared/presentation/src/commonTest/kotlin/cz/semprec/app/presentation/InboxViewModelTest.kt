package cz.semprec.app.presentation

import androidx.lifecycle.ViewModelStore
import cz.semprec.app.core.FailureKind
import cz.semprec.app.domain.InboxCardKind
import cz.semprec.app.domain.InboxCardStatus
import cz.semprec.app.domain.InboxChoice
import cz.semprec.app.domain.InboxControl
import cz.semprec.app.domain.InboxField
import cz.semprec.app.domain.InboxGroup
import cz.semprec.app.domain.InboxOutcome
import cz.semprec.app.domain.InboxRevision
import cz.semprec.app.domain.InboxType
import cz.semprec.app.domain.InboxValue
import cz.semprec.app.domain.RepositoryResult
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

private val stackOfTwo = inboxContent(inboxTaskCard("a"), inboxTaskCard("b", name = "Pay the rent"))

private fun InboxState.field(key: String, card: Int = 0) = cards[card].groups.flatMap {
    it.fields
}.first { it.key == key }

@OptIn(ExperimentalCoroutinesApi::class)
class InboxViewModelTest : MainDispatcherTest() {
    private fun viewModel(repository: ScriptedInbox) = inboxFactory(repository).inboxViewModel()

    @Test fun `starts loading and then shows the cards in the order of the stack`() = runTest(dispatcher) {
        val vm = viewModel(ScriptedInbox(stackOfTwo))
        assertEquals(InboxState(), vm.state.value)
        runCurrent()

        val state = vm.state.value
        assertEquals(InboxPhase.CONTENT, state.phase)
        assertEquals(listOf("a", "b"), state.cards.map { it.id })
        val top = state.cards.first()
        assertEquals(InboxCardType.TASK, top.type)
        assertEquals(InboxCardPhase.PROPOSED, top.phase)
        assertEquals(InboxApprovable.READY, top.approvable)
        assertEquals(InboxOriginKind.CAPTURE, top.origin?.kind)
        assertEquals("Send the invoice tomorrow", top.origin?.text)
        assertEquals(listOf("name", "date", "allDay", "project"), top.groups.single().fields.map { it.key })
        assertEquals("Send the invoice", state.field("name").text)
        assertEquals("2026-10-17", state.field("date").date)
        assertEquals(InboxFieldType.DATETIME, state.field("date").type)
        assertTrue(state.field("name").required)
        assertEquals(false, state.canUndo)
        vm.close()
    }

    @Test fun `the items of a field read as names once the top cards have asked for them`() = runTest(dispatcher) {
        val repository = ScriptedInbox(inboxContent(inboxTaskCard("a"), inboxTaskCard("b"), inboxTaskCard("c")))
        val vm = viewModel(repository)
        runCurrent()

        assertEquals(listOf("options a project", "options b project"), repository.calls.filter { "options" in it })
        val project = vm.state.value.field("project")
        assertEquals(listOf("Project one"), project.selected.map { it.label })
        assertTrue(project.needsPicker)
        vm.close()
    }

    @Test fun `an expected failure is an error with its kind and retry recovers`() = runTest(dispatcher) {
        val failure = RepositoryResult.Failure(FailureKind.UNAUTHORIZED)
        val repository = ScriptedInbox({ failure }, stackOfTwo)
        val vm = viewModel(repository)
        runCurrent()
        assertEquals(InboxState(InboxPhase.ERROR, FailureKind.UNAUTHORIZED), vm.state.value)

        vm.onAction(InboxAction.Retry)
        assertEquals(InboxState(), vm.state.value)
        runCurrent()
        assertEquals(InboxPhase.CONTENT, vm.state.value.phase)
        assertEquals(2, repository.stackCalls)
        vm.close()
    }

    @Test fun `an unexpected exception is an error without a failure kind`() = runTest(dispatcher) {
        val vm = viewModel(ScriptedInbox(crashes()))
        runCurrent()
        assertEquals(InboxState(InboxPhase.ERROR), vm.state.value)
        vm.close()
    }

    @Test fun `a refresh keeps the cards on screen and a refresh that fails leaves them as they were`() =
        runTest(dispatcher) {
            val gate = CompletableDeferred<Unit>()
            val fresh = RepositoryResult.Content(inboxStack(inboxTaskCard("c")))
            val failure = RepositoryResult.Failure(FailureKind.UNAVAILABLE)
            val vm = viewModel(ScriptedInbox(stackOfTwo, answersLate(gate, fresh), { failure }))
            runCurrent()

            vm.onAction(InboxAction.Refresh)
            assertEquals(true, vm.state.value.refreshing)
            assertEquals(listOf("a", "b"), vm.state.value.cards.map { it.id })
            gate.complete(Unit)
            runCurrent()
            assertEquals(listOf("c"), vm.state.value.cards.map { it.id })
            assertEquals(false, vm.state.value.refreshing)

            vm.onAction(InboxAction.Refresh)
            runCurrent()
            assertEquals(listOf("c"), vm.state.value.cards.map { it.id })
            assertEquals(InboxPhase.CONTENT, vm.state.value.phase)
            vm.close()
        }

    @Test fun `a superseded load that completes late never overwrites the newer result`() = runTest(dispatcher) {
        val gate = CompletableDeferred<Unit>()
        val failure = RepositoryResult.Failure(FailureKind.UNAVAILABLE)
        val vm = viewModel(ScriptedInbox(answersLate(gate, failure), stackOfTwo))
        runCurrent()
        vm.onAction(InboxAction.Retry)
        runCurrent()
        assertEquals(InboxPhase.CONTENT, vm.state.value.phase)
        gate.complete(Unit)
        runCurrent()
        assertEquals(InboxPhase.CONTENT, vm.state.value.phase)
        vm.close()
    }

    @Test fun `retry cancels the running load`() = runTest(dispatcher) {
        val repository = ScriptedInbox(neverAnswers(), stackOfTwo)
        val vm = viewModel(repository)
        runCurrent()
        vm.onAction(InboxAction.Retry)
        runCurrent()
        assertEquals(1, repository.stackCancellations)
        assertEquals(InboxPhase.CONTENT, vm.state.value.phase)
        vm.close()
    }

    @Test fun `close cancels in flight work without a failure state and is idempotent`() = runTest(dispatcher) {
        val repository = ScriptedInbox(neverAnswers())
        val vm = viewModel(repository)
        runCurrent()
        vm.close()
        vm.close()
        runCurrent()
        assertTrue(vm.isClosed)
        assertEquals(1, repository.stackCancellations)
        assertEquals(InboxState(), vm.state.value)
    }

    @Test fun `a closed ViewModel ignores actions`() = runTest(dispatcher) {
        val repository = ScriptedInbox(stackOfTwo)
        val vm = viewModel(repository)
        runCurrent()
        vm.close()
        vm.onAction(InboxAction.Retry)
        vm.onAction(InboxAction.Approve)
        vm.onAction(InboxAction.SetText("a", "name", "x"))
        runCurrent()
        assertEquals(1, repository.stackCalls)
        assertEquals(emptyList(), repository.calls.filter { "confirm" in it || "edit" in it })
        assertEquals(emptyList(), vm.effects.toList())
    }

    @Test fun `a load that completes late after close never publishes`() = runTest(dispatcher) {
        val gate = CompletableDeferred<Unit>()
        val vm = viewModel(ScriptedInbox(answersLate(gate, RepositoryResult.Content(inboxStack(inboxTaskCard("a"))))))
        runCurrent()
        vm.close()
        gate.complete(Unit)
        runCurrent()
        assertEquals(InboxState(), vm.state.value)
    }

    @Test fun `clearing the store without close ends the ViewModel`() = runTest(dispatcher) {
        val store = ViewModelStore()
        val repository = ScriptedInbox(neverAnswers())
        val vm = store.provide { viewModel(repository) }
        runCurrent()
        store.clear()
        runCurrent()
        assertTrue(vm.isClosed)
        assertEquals(1, repository.stackCancellations)
    }

    @Test fun `a change shows at once and the answer of the server replaces it`() = runTest(dispatcher) {
        val repository = ScriptedInbox(stackOfTwo)
        val vm = viewModel(repository)
        runCurrent()

        vm.onAction(InboxAction.SetText("a", "name", "Send the invoice to Alza"))
        assertEquals("Send the invoice to Alza", vm.state.value.field("name").text)
        assertEquals(true, vm.state.value.cards.first().saving)
        runCurrent()

        assertEquals("Send the invoice to Alza", vm.state.value.field("name").text)
        assertEquals(false, vm.state.value.cards.first().saving)
        assertEquals(listOf("edit a v0 [name]"), repository.calls.filter { it.startsWith("edit") })
        vm.close()
    }

    @Test fun `a switch a date and a time are written under their own fields`() = runTest(dispatcher) {
        val repository = ScriptedInbox(stackOfTwo)
        val vm = viewModel(repository)
        runCurrent()

        vm.onAction(InboxAction.SetFlag("a", "allDay", on = true))
        vm.onAction(InboxAction.SetDate("a", "date", "2026-11-01"))
        vm.onAction(InboxAction.SetTime("a", "date", "14:30"))
        runCurrent()

        assertEquals(
            listOf("edit a v0 [allDay]", "edit a v1 [date]", "edit a v2 [timeFrom]"),
            repository.calls.filter { it.startsWith("edit") },
        )
        assertEquals(true, vm.state.value.field("allDay").flag)
        assertEquals("2026-11-01", vm.state.value.field("date").date)
        assertEquals("14:30", vm.state.value.field("date").time)
        vm.close()
    }

    @Test fun `writes go one after the other each on the card the one before left`() = runTest(dispatcher) {
        val gate = CompletableDeferred<Unit>()
        val repository = ScriptedInbox(stackOfTwo)
        repository.onEdit = { card, _ ->
            if (card.version == "v0") gate.await()
            RepositoryResult.Content(card.copy(version = "next-${card.version}"))
        }
        val vm = viewModel(repository)
        runCurrent()

        vm.onAction(InboxAction.SetText("a", "name", "One"))
        vm.onAction(InboxAction.SetText("a", "name", "Two"))
        runCurrent()
        assertEquals(listOf("edit a v0 [name]"), repository.calls.filter { it.startsWith("edit") })
        assertEquals("Two", vm.state.value.field("name").text)
        gate.complete(Unit)
        runCurrent()

        assertEquals(
            listOf("edit a v0 [name]", "edit a next-v0 [name]"),
            repository.calls.filter { it.startsWith("edit") },
        )
        assertEquals("Two", vm.state.value.field("name").text)
        assertEquals(false, vm.state.value.cards.first().saving)
        vm.close()
    }

    @Test fun `a write that fails is said so and the stack is read again`() = runTest(dispatcher) {
        val repository = ScriptedInbox(stackOfTwo)
        repository.onEdit = { _, _ -> RepositoryResult.Failure(FailureKind.REJECTED) }
        val vm = viewModel(repository)
        runCurrent()

        vm.onAction(InboxAction.SetText("a", "name", "Changed"))
        runCurrent()

        assertEquals(InboxProblem.EDIT, vm.state.value.problem)
        assertEquals(FailureKind.REJECTED, vm.state.value.problemFailure)
        assertEquals(2, repository.stackCalls)
        assertEquals("Send the invoice", vm.state.value.field("name").text)
        vm.onAction(InboxAction.DismissProblem)
        assertNull(vm.state.value.problem)
        vm.close()
    }

    @Test fun `an edit the card has no place for sends nothing`() = runTest(dispatcher) {
        val repository = ScriptedInbox(stackOfTwo)
        val vm = viewModel(repository)
        runCurrent()
        vm.onAction(InboxAction.SetText("a", "followupTask", "x"))
        vm.onAction(InboxAction.SetText("missing", "name", "x"))
        vm.onAction(InboxAction.SetText("a", "missing", "x"))
        runCurrent()
        assertEquals(emptyList(), repository.calls.filter { it.startsWith("edit") })
        vm.close()
    }

    @Test fun `a blank required field blocks the approval until it is filled`() = runTest(dispatcher) {
        val repository = ScriptedInbox(stackOfTwo)
        val vm = viewModel(repository)
        runCurrent()

        vm.onAction(InboxAction.SetText("a", "name", "  "))
        assertEquals(InboxApprovable.MISSING_FIELDS, vm.state.value.cards.first().approvable)
        assertTrue(vm.state.value.field("name").missing)
        vm.onAction(InboxAction.Approve)
        runCurrent()
        assertEquals(emptyList(), repository.calls.filter { it.startsWith("confirm") })
        assertEquals(2, vm.state.value.cards.size)
        vm.close()
    }

    @Test fun `approving confirms the top card and offers what it created`() = runTest(dispatcher) {
        val repository = ScriptedInbox(stackOfTwo)
        val vm = viewModel(repository)
        runCurrent()

        vm.onAction(InboxAction.Approve)
        assertEquals(true, vm.state.value.busy)
        runCurrent()

        val state = vm.state.value
        assertEquals(listOf("b"), state.cards.map { it.id })
        assertEquals(1, state.handled)
        assertEquals(true, state.canUndo)
        assertEquals(false, state.busy)
        assertEquals(InboxResultState("Task", "tasks", "item-1"), state.result)
        assertEquals(listOf("confirm a null"), repository.calls.filter { it.startsWith("confirm") })
        vm.close()
    }

    @Test fun `the toast opens the item once and dismisses itself`() = runTest(dispatcher) {
        val vm = viewModel(ScriptedInbox(stackOfTwo))
        runCurrent()
        vm.onAction(InboxAction.Approve)
        runCurrent()

        vm.onAction(InboxAction.OpenResult)
        vm.onAction(InboxAction.OpenResult)
        val received = mutableListOf<InboxEffect>()
        val collector = launch { vm.effects.collect { received += it } }
        runCurrent()
        collector.cancel()

        assertEquals(listOf<InboxEffect>(InboxEffect.OpenItem("tasks", "item-1")), received)
        assertNull(vm.state.value.result)
        vm.close()
    }

    @Test fun `a decision that makes nothing shows no toast and dismissing hides it`() = runTest(dispatcher) {
        val repository = ScriptedInbox(stackOfTwo)
        repository.onConfirm = { _, _ -> RepositoryResult.Content(null) }
        val vm = viewModel(repository)
        runCurrent()
        vm.onAction(InboxAction.Approve)
        runCurrent()
        assertNull(vm.state.value.result)

        repository.onConfirm = { _, _ -> RepositoryResult.Content(InboxOutcome("Task", null, null)) }
        vm.onAction(InboxAction.Approve)
        runCurrent()
        assertNotNull(vm.state.value.result)
        vm.onAction(InboxAction.OpenResult)
        runCurrent()
        assertNull(vm.state.value.result)
        vm.close()
    }

    @Test fun `discarding drops the top card and undo returns it`() = runTest(dispatcher) {
        val repository = ScriptedInbox(stackOfTwo, inboxContent(inboxTaskCard("a"), inboxTaskCard("b", name = "Pay")))
        val vm = viewModel(repository)
        runCurrent()

        vm.onAction(InboxAction.Reject)
        runCurrent()
        assertEquals(listOf("b"), vm.state.value.cards.map { it.id })
        assertEquals(1, vm.state.value.dropped)
        assertEquals(listOf("reject a"), repository.calls.filter { it.startsWith("reject") })

        vm.onAction(InboxAction.Undo)
        runCurrent()
        assertEquals(listOf("reopen a"), repository.calls.filter { it.startsWith("reopen") })
        assertEquals(listOf("a", "b"), vm.state.value.cards.map { it.id })
        assertEquals(0, vm.state.value.dropped)
        assertEquals(false, vm.state.value.canUndo)
        vm.onAction(InboxAction.Undo)
        runCurrent()
        assertEquals(1, repository.calls.count { it.startsWith("reopen") })
        vm.close()
    }

    @Test fun `an undo that fails keeps the decision and says so`() = runTest(dispatcher) {
        val repository = ScriptedInbox(stackOfTwo)
        val vm = viewModel(repository)
        runCurrent()
        vm.onAction(InboxAction.Reject)
        runCurrent()
        repository.onUnit = { RepositoryResult.Failure(FailureKind.UNAVAILABLE) }

        vm.onAction(InboxAction.Undo)
        runCurrent()

        assertEquals(InboxProblem.UNDO, vm.state.value.problem)
        assertEquals(true, vm.state.value.canUndo)
        assertEquals(1, vm.state.value.dropped)
        vm.close()
    }

    @Test fun `a decision the server refuses keeps the card and reads the stack again`() = runTest(dispatcher) {
        val repository = ScriptedInbox(stackOfTwo)
        repository.onConfirm = { _, _ -> RepositoryResult.Failure(FailureKind.REJECTED) }
        val vm = viewModel(repository)
        runCurrent()

        vm.onAction(InboxAction.Approve)
        runCurrent()

        assertEquals(InboxProblem.DECISION, vm.state.value.problem)
        assertEquals(false, vm.state.value.busy)
        assertEquals(2, vm.state.value.cards.size)
        assertEquals(0, vm.state.value.handled)
        assertEquals(2, repository.stackCalls)
        vm.close()
    }

    @Test fun `a second decision waits while one is in flight`() = runTest(dispatcher) {
        val gate = CompletableDeferred<Unit>()
        val repository = ScriptedInbox(stackOfTwo)
        repository.onConfirm = { _, _ ->
            gate.await()
            RepositoryResult.Content(null)
        }
        val vm = viewModel(repository)
        runCurrent()

        vm.onAction(InboxAction.Approve)
        runCurrent()
        vm.onAction(InboxAction.Approve)
        vm.onAction(InboxAction.Reject)
        gate.complete(Unit)
        runCurrent()

        assertEquals(1, repository.calls.count { it.startsWith("confirm") })
        assertEquals(emptyList(), repository.calls.filter { it.startsWith("reject") })
        vm.close()
    }

    @Test fun `a decision goes to the server after the writes that came before it`() = runTest(dispatcher) {
        val gate = CompletableDeferred<Unit>()
        val repository = ScriptedInbox(stackOfTwo)
        repository.onEdit = { card, _ ->
            gate.await()
            RepositoryResult.Content(card.copy(version = "saved"))
        }
        val vm = viewModel(repository)
        runCurrent()

        vm.onAction(InboxAction.SetText("a", "name", "Edited"))
        vm.onAction(InboxAction.Approve)
        runCurrent()
        assertEquals(emptyList(), repository.calls.filter { it.startsWith("confirm") })
        gate.complete(Unit)
        runCurrent()

        assertEquals(listOf("confirm a null"), repository.calls.filter { it.startsWith("confirm") })
        vm.close()
    }

    @Test fun `a capture that needs clarifying gets the type that is picked and stays while Semp computes`() =
        runTest(dispatcher) {
            val computing = inboxClarifyCard("c").copy(status = InboxCardStatus.COMPUTING)
            val repository = ScriptedInbox(inboxContent(inboxClarifyCard("c")), inboxContent(computing), inboxContent())
            repository.types = RepositoryResult.Content(listOf(InboxType("t1", "Contact", "C", "People")))
            val vm = viewModel(repository)
            runCurrent()

            val tile = vm.state.value.field("type")
            assertEquals(InboxFieldType.TILE, tile.type)
            assertEquals(listOf("Contact"), tile.options.map { it.label })
            assertEquals(InboxApprovable.MISSING_FIELDS, vm.state.value.cards.first().approvable)

            vm.onAction(InboxAction.Pick("c", "type", "t1"))
            assertEquals(InboxApprovable.READY, vm.state.value.cards.first().approvable)
            assertEquals(listOf(true), vm.state.value.field("type").options.map { it.selected })
            vm.onAction(InboxAction.Approve)
            runCurrent()

            assertEquals(listOf("type c t1"), repository.calls.filter { it.startsWith("type ") })
            assertEquals(listOf("c"), vm.state.value.cards.map { it.id })
            assertEquals(InboxCardPhase.COMPUTING, vm.state.value.cards.first().phase)
            assertEquals(0, vm.state.value.handled)
            assertEquals(false, vm.state.value.canUndo)
            vm.close()
        }

    @Test fun `every kind of card of the domain has its kind on the screen`() {
        InboxCardKind.entries.forEach { assertEquals(it.name, InboxCardType.valueOf(it.name).name) }
        assertEquals(InboxCardKind.entries.size, InboxCardType.entries.size)
    }

    @Test fun `the types are not asked for unless a card needs them`() = runTest(dispatcher) {
        val repository = ScriptedInbox(stackOfTwo)
        val vm = viewModel(repository)
        runCurrent()
        assertEquals(emptyList(), repository.calls.filter { it == "types" })
        vm.close()
    }

    @Test fun `a speaker is picked by a new proposal of the card`() = runTest(dispatcher) {
        val repository = ScriptedInbox(inboxContent(inboxSpeakerCard("s")))
        val vm = viewModel(repository)
        runCurrent()
        val who = vm.state.value.field("who")
        assertEquals(listOf("Jana", "Petr"), who.options.map { it.label })
        assertEquals(listOf("Hello there"), vm.state.value.cards.first().quotes)
        assertEquals("Talks about design", vm.state.value.cards.first().reason)
        assertEquals(InboxApprovable.MISSING_FIELDS, vm.state.value.cards.first().approvable)

        vm.onAction(InboxAction.Pick("s", "who", "pe2"))
        runCurrent()

        val revision = InboxRevision.LinkSpeaker("pe2", "S3")
        assertEquals(listOf("revise s $revision"), repository.calls.filter { "revise" in it })
        vm.close()
    }

    @Test fun `a picker waits for the items of its field and a pick closes it`() = runTest(dispatcher) {
        val gate = CompletableDeferred<Unit>()
        val repository = ScriptedInbox(inboxContent(inboxTaskCard("a")))
        repository.onOptions = { _, _ ->
            gate.await()
            RepositoryResult.Content(
                listOf(
                    InboxChoice("p1", "One"),
                    InboxChoice("p2", "Two"),
                    InboxChoice(null, "No project", none = true),
                ),
            )
        }
        val vm = viewModel(repository)
        runCurrent()

        vm.onAction(InboxAction.OpenPicker("a", "project"))
        assertEquals(InboxPickerPhase.LOADING, vm.state.value.picker?.phase)
        gate.complete(Unit)
        runCurrent()
        val picker = assertNotNull(vm.state.value.picker)
        assertEquals(InboxPickerPhase.READY, picker.phase)
        assertEquals(listOf("One", "Two", "No project"), picker.options.map { it.label })
        assertEquals(listOf(true, false, false), picker.options.map { it.selected })
        assertEquals(1, repository.calls.count { it.startsWith("options") })

        vm.onAction(InboxAction.Pick("a", "project", "p2"))
        runCurrent()
        assertNull(vm.state.value.picker)
        assertEquals(listOf("Two"), vm.state.value.field("project").selected.map { it.label })
        vm.close()
    }

    @Test fun `a picker whose items failed shows it and asks again when it is opened again`() = runTest(dispatcher) {
        val repository = ScriptedInbox(inboxContent(inboxTaskCard("a")))
        repository.onOptions = { _, _ -> RepositoryResult.Failure(FailureKind.UNAVAILABLE) }
        val vm = viewModel(repository)
        runCurrent()

        vm.onAction(InboxAction.OpenPicker("a", "project"))
        runCurrent()
        assertEquals(InboxPickerPhase.ERROR, vm.state.value.picker?.phase)

        repository.onOptions = { _, _ -> RepositoryResult.Content(listOf(InboxChoice("p1", "One"))) }
        vm.onAction(InboxAction.ClosePicker)
        assertNull(vm.state.value.picker)
        vm.onAction(InboxAction.OpenPicker("a", "project"))
        runCurrent()
        assertEquals(InboxPickerPhase.READY, vm.state.value.picker?.phase)
        assertEquals(3, repository.calls.count { it.startsWith("options") })
        vm.close()
    }

    @Test fun `a picker opens only for a field that picks`() = runTest(dispatcher) {
        val vm = viewModel(ScriptedInbox(stackOfTwo))
        runCurrent()
        vm.onAction(InboxAction.OpenPicker("a", "name"))
        vm.onAction(InboxAction.OpenPicker("missing", "project"))
        assertNull(vm.state.value.picker)
        vm.close()
    }

    @Test fun `a card that is computing is read again until its proposal is there`() = runTest(dispatcher) {
        val computing = inboxTaskCard("a").copy(status = InboxCardStatus.COMPUTING)
        val repository =
            ScriptedInbox(inboxContent(computing), inboxContent(computing), inboxContent(inboxTaskCard("a")))
        val vm = viewModel(repository)
        runCurrent()
        assertEquals(InboxApprovable.COMPUTING, vm.state.value.cards.first().approvable)

        advanceTimeBy(3_001)
        runCurrent()
        assertEquals(2, repository.stackCalls)
        advanceTimeBy(3_001)
        runCurrent()
        assertEquals(3, repository.stackCalls)
        assertEquals(InboxApprovable.READY, vm.state.value.cards.first().approvable)

        advanceTimeBy(30_000)
        runCurrent()
        assertEquals(3, repository.stackCalls)
        vm.close()
    }

    @Test fun `computing a card again asks Semp and reads the stack`() = runTest(dispatcher) {
        val failed = inboxTaskCard("a").copy(status = InboxCardStatus.COMPUTE_FAILED)
        val repository =
            ScriptedInbox(
                inboxContent(failed),
                inboxContent(failed.copy(status = InboxCardStatus.COMPUTING)),
                inboxContent(),
            )
        val vm = viewModel(repository)
        runCurrent()
        assertEquals(InboxApprovable.COMPUTE_FAILED, vm.state.value.cards.first().approvable)

        vm.onAction(InboxAction.Recompute("a"))
        runCurrent()

        assertEquals(listOf("recompute a"), repository.calls.filter { it.startsWith("recompute") })
        assertEquals(InboxCardPhase.COMPUTING, vm.state.value.cards.first().phase)
        vm.close()
    }

    @Test fun `a failed recompute is said so`() = runTest(dispatcher) {
        val repository = ScriptedInbox(stackOfTwo)
        repository.onUnit = { RepositoryResult.Failure(FailureKind.REJECTED) }
        val vm = viewModel(repository)
        runCurrent()
        vm.onAction(InboxAction.Recompute("a"))
        runCurrent()
        assertEquals(InboxProblem.RECOMPUTE, vm.state.value.problem)
        vm.close()
    }

    @Test fun `the secret of a server goes with the approval and is never in the state`() = runTest(dispatcher) {
        val secret = InboxField("credential", InboxControl.SECRET, required = true)
        val mcp = inboxTaskCard("m").copy(kind = InboxCardKind.MCP)
        val withSecret = mcp.copy(schema = mcp.schema!!.copy(groups = listOf(InboxGroup("g", listOf(secret)))))
        val repository = ScriptedInbox(inboxContent(withSecret))
        val vm = viewModel(repository)
        runCurrent()
        assertEquals(InboxApprovable.MISSING_FIELDS, vm.state.value.cards.first().approvable)

        vm.onAction(InboxAction.SetSecret("m", "sk-123"))
        val field = vm.state.value.field("credential")
        assertEquals(true, field.flag)
        assertEquals("", field.text)
        assertEquals(InboxApprovable.READY, vm.state.value.cards.first().approvable)
        vm.onAction(InboxAction.Approve)
        runCurrent()

        assertEquals(listOf("confirm m sk-123"), repository.calls.filter { it.startsWith("confirm") })
        vm.close()
    }

    @Test fun `a card returns to the last proposal of Semp`() = runTest(dispatcher) {
        val repository = ScriptedInbox(stackOfTwo)
        val vm = viewModel(repository)
        runCurrent()
        vm.onAction(InboxAction.SetText("a", "name", "Mine"))
        runCurrent()
        repository.onReset = { card -> RepositoryResult.Content(inboxTaskCard(card.id, version = "fresh")) }

        vm.onAction(InboxAction.Reset("a"))
        runCurrent()

        assertEquals("Send the invoice", vm.state.value.field("name").text)
        assertEquals(listOf("reset a"), repository.calls.filter { it.startsWith("reset") })
        vm.close()
    }

    @Test fun `a card read again keeps what the person set while its version is the same`() = runTest(dispatcher) {
        val repository = ScriptedInbox(stackOfTwo, inboxContent(inboxTaskCard("a", version = "v1"), inboxTaskCard("b")))
        repository.onEdit = { card, _ ->
            RepositoryResult.Content(
                card.copy(
                    version = "v1",
                    editedKeys = setOf("primary.name"),
                    userValues = mapOf("primary.allDay" to InboxValue.Flag(true)),
                ),
            )
        }
        val vm = viewModel(repository)
        runCurrent()
        vm.onAction(InboxAction.SetFlag("a", "allDay", on = true))
        runCurrent()
        assertEquals(true, vm.state.value.cards.first().edited)

        vm.onAction(InboxAction.Refresh)
        runCurrent()

        assertEquals(true, vm.state.value.cards.first().edited)
        assertEquals(true, vm.state.value.field("allDay").flag)
        assertEquals(false, vm.state.value.cards[1].edited)
        vm.close()
    }

    @Test fun `a write elsewhere in the window reads the stack again`() = runTest(dispatcher) {
        val changes = MutableSharedFlow<Unit>(extraBufferCapacity = 1)
        val repository = ScriptedInbox(stackOfTwo, inboxContent(inboxTaskCard("c")))
        val vm = InboxViewModelFactory(repository, repository, FakeAttachmentFiles(), changes).inboxViewModel()
        runCurrent()
        assertEquals(1, repository.stackCalls)
        changes.emit(Unit)
        runCurrent()
        assertEquals(2, repository.stackCalls)
        assertEquals(listOf("c"), vm.state.value.cards.map { it.id })
        vm.close()
    }
}
