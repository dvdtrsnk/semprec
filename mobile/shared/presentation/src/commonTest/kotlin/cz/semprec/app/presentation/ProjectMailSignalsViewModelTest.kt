package cz.semprec.app.presentation

import androidx.lifecycle.ViewModelStore
import cz.semprec.app.core.FailureKind
import cz.semprec.app.core.MailSignalField
import cz.semprec.app.domain.MailSignalAssignment
import cz.semprec.app.domain.MailSignalPerson
import cz.semprec.app.domain.MailSignalPreview
import cz.semprec.app.domain.MailSignalSet
import cz.semprec.app.domain.MailSignalsOutcome
import cz.semprec.app.domain.MailThreadSummary
import cz.semprec.app.domain.ProjectMailSignals
import cz.semprec.app.domain.ProjectMailSignalsRepository
import cz.semprec.app.domain.RepositoryResult
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.withContext
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

private val SAVED = MailSignalSet(domains = listOf("novak.cz"), keywords = listOf("Faktura"))
private val PEOPLE = listOf(MailSignalPerson("u1", "Petr Novák", "petr@novak.cz"))

private fun project(signals: MailSignalSet = SAVED) = ProjectMailSignals("p1", signals, "2026-11-20T10:00:00Z", PEOPLE)

private fun thread(id: String) = MailThreadSummary(
    threadId = id,
    subject = "Faktura $id",
    lastMessageAt = "2026-11-19T08:00:00Z",
    senderName = "Petr Novák",
    senderAddress = "petr@novak.cz",
    senderRelationship = null,
    messageCount = 1,
    preview = null,
    hasAttachment = false,
    unread = false,
    flagged = false,
    mailboxNames = emptyList(),
    project = null,
    company = null,
    hasSempDraft = false,
)

private fun preview(vararg ids: String, total: Int = ids.size, alreadyAssigned: Int = 0) =
    RepositoryResult.Content(MailSignalsOutcome.Done(MailSignalPreview(total, alreadyAssigned, ids.map(::thread))))

private fun item(id: String) =
    MailSignalThreadItem(id, "Faktura $id", "Petr Novák", "petr@novak.cz", "2026-11-19T08:00:00Z")

/** A scripted signals repository: every call is recorded and answered by the current answer of its kind. */
private class FakeMailSignals : ProjectMailSignalsRepository {
    var signals: suspend () -> RepositoryResult<ProjectMailSignals> = { RepositoryResult.Content(project()) }
    var save: suspend (MailSignalSet) -> RepositoryResult<MailSignalsOutcome<ProjectMailSignals>> =
        { RepositoryResult.Content(MailSignalsOutcome.Done(project(it))) }
    var preview: suspend (MailSignalSet?) -> RepositoryResult<MailSignalsOutcome<MailSignalPreview>> =
        { preview("t1", "t2") }
    var apply: suspend (List<String>) -> RepositoryResult<MailSignalAssignment> =
        { RepositoryResult.Content(MailSignalAssignment(it.size, 0)) }

    val loads = mutableListOf<String>()
    val saves = mutableListOf<MailSignalSet>()
    val previews = mutableListOf<MailSignalSet?>()
    val applies = mutableListOf<List<String>>()

    override suspend fun signals(projectId: String) = signals().also { loads += projectId }

    override suspend fun save(projectId: String, signals: MailSignalSet) = save.invoke(signals.also { saves += it })

    override suspend fun preview(projectId: String, draft: MailSignalSet?) =
        preview.invoke(draft.also { previews += it })

    override suspend fun apply(projectId: String, threadIds: List<String>) =
        apply.invoke(threadIds.also { applies += it })
}

@OptIn(ExperimentalCoroutinesApi::class)
class ProjectMailSignalsViewModelTest : MainDispatcherTest() {
    private val repository = FakeMailSignals()

    private fun TestScope.ready(): ProjectMailSignalsViewModel =
        ProjectMailSignalsViewModelFactory(repository).viewModel("p1").also { runCurrent() }

    private fun ProjectMailSignalsViewModel.type(field: MailSignalField, text: String) {
        onAction(ProjectMailSignalsAction.EditInput(field, text))
        onAction(ProjectMailSignalsAction.Add(field))
    }

    private fun TestScope.settle() {
        advanceTimeBy(MAIL_SIGNALS_PREVIEW_DELAY_MILLIS)
        runCurrent()
    }

    // MARK: Load

    @Test fun `the saved signals load with the people and a preview of the saved signals`() = runTest(dispatcher) {
        val vm = ProjectMailSignalsViewModelFactory(repository).viewModel("p1")
        assertEquals(ProjectMailSignalsState(), vm.state.value)
        runCurrent()

        assertEquals(listOf("p1"), repository.loads)
        assertEquals(listOf<MailSignalSet?>(null), repository.previews)
        val state = vm.state.value
        assertEquals(ProjectMailSignalsPhase.READY, state.phase)
        assertEquals(listOf(MailSignalPersonItem("u1", "Petr Novák", "petr@novak.cz")), state.people)
        assertEquals(listOf("novak.cz"), state.domains)
        assertEquals(emptyList(), state.addresses)
        assertEquals(listOf("Faktura"), state.keywords)
        assertEquals(
            MailSignalsPreviewState(MailSignalsPreviewPhase.READY, null, 2, 0, listOf(item("t1"), item("t2"))),
            state.preview,
        )
        assertFalse(state.unsaved)
        assertFalse(state.canSave)
        assertTrue(state.canAssign)
        vm.close()
    }

    @Test fun `a failed load is an error that retry loads again`() = runTest(dispatcher) {
        val failures = listOf<suspend () -> RepositoryResult<ProjectMailSignals>>(
            { RepositoryResult.Failure(FailureKind.NOT_FOUND) },
            { error("unexpected") },
        )
        val expected = listOf(FailureKind.NOT_FOUND, null)
        failures.zip(expected).forEach { (answer, kind) ->
            repository.signals = answer
            val vm = ready()
            assertEquals(ProjectMailSignalsPhase.ERROR, vm.state.value.phase)
            assertEquals(kind, vm.state.value.failure)
            repository.signals = { RepositoryResult.Content(project()) }
            vm.onAction(ProjectMailSignalsAction.Retry)
            assertEquals(ProjectMailSignalsPhase.LOADING, vm.state.value.phase)
            runCurrent()
            assertEquals(ProjectMailSignalsPhase.READY, vm.state.value.phase)
            vm.close()
        }
    }

    @Test fun `there is no preview and nothing to edit before the signals loaded`() = runTest(dispatcher) {
        repository.signals = { RepositoryResult.Failure(FailureKind.UNAVAILABLE) }
        val vm = ready()
        vm.type(MailSignalField.DOMAINS, "novak.cz")
        vm.onAction(ProjectMailSignalsAction.RetryPreview)
        vm.onAction(ProjectMailSignalsAction.Save)
        vm.onAction(ProjectMailSignalsAction.Assign)
        settle()
        assertEquals(emptyList(), repository.previews)
        assertEquals(emptyList(), repository.saves)
        assertEquals(emptyList(), vm.state.value.domains)
        vm.close()
    }

    // MARK: Editing

    @Test fun `an added value is normalized and empties its field and is unsaved`() = runTest(dispatcher) {
        val vm = ready()
        vm.type(MailSignalField.DOMAINS, "https://www.Pekarna.cz/")
        vm.type(MailSignalField.ADDRESSES, " Jana@Pekarna.CZ ")
        vm.type(MailSignalField.KEYWORDS, "  smlouva   o dílo ")

        val state = vm.state.value
        assertEquals(listOf("novak.cz", "pekarna.cz"), state.domains)
        assertEquals(listOf("jana@pekarna.cz"), state.addresses)
        assertEquals(listOf("Faktura", "smlouva o dílo"), state.keywords)
        assertEquals(listOf("", "", ""), listOf(state.domainInput, state.addressInput, state.keywordInput))
        assertTrue(state.unsaved)
        assertTrue(state.canSave)
        assertFalse(state.canAssign)
        vm.close()
    }

    @Test fun `a value already listed only empties its field`() = runTest(dispatcher) {
        val vm = ready()
        vm.type(MailSignalField.KEYWORDS, "FAKTURA")
        settle()
        assertEquals(listOf("Faktura"), vm.state.value.keywords)
        assertEquals("", vm.state.value.keywordInput)
        assertFalse(vm.state.value.unsaved)
        assertEquals(listOf<MailSignalSet?>(null), repository.previews)
        vm.close()
    }

    @Test fun `an invalid value marks its list and stays typed until the person changes it`() = runTest(dispatcher) {
        val vm = ready()
        vm.type(MailSignalField.DOMAINS, "localhost")
        assertEquals(MailSignalField.DOMAINS, vm.state.value.invalidField)
        assertEquals("localhost", vm.state.value.domainInput)
        assertEquals(listOf("novak.cz"), vm.state.value.domains)

        vm.onAction(ProjectMailSignalsAction.EditInput(MailSignalField.KEYWORDS, "x"))
        assertEquals(MailSignalField.DOMAINS, vm.state.value.invalidField)
        vm.onAction(ProjectMailSignalsAction.EditInput(MailSignalField.DOMAINS, "localhost.cz"))
        assertNull(vm.state.value.invalidField)
        vm.close()
    }

    @Test fun `a blank field adds nothing`() = runTest(dispatcher) {
        val vm = ready()
        val before = vm.state.value
        vm.type(MailSignalField.ADDRESSES, "   ")
        assertEquals(before.copy(addressInput = "   "), vm.state.value)
        vm.close()
    }

    @Test fun `a removed value leaves its list`() = runTest(dispatcher) {
        val vm = ready()
        vm.onAction(ProjectMailSignalsAction.Remove(MailSignalField.KEYWORDS, "Faktura"))
        assertEquals(emptyList(), vm.state.value.keywords)
        assertTrue(vm.state.value.unsaved)
        vm.onAction(ProjectMailSignalsAction.Remove(MailSignalField.KEYWORDS, "Faktura"))
        assertEquals(emptyList(), vm.state.value.keywords)
        vm.close()
    }

    // MARK: Preview

    @Test fun `the preview asks for the lists on screen once the person pauses`() = runTest(dispatcher) {
        val vm = ready()
        repository.previews.clear()
        vm.type(MailSignalField.KEYWORDS, "smlouva")
        assertEquals(MailSignalsPreviewPhase.LOADING, vm.state.value.preview.phase)
        assertEquals(2, vm.state.value.preview.threads.size, "The previous answer stays while the next one loads")
        advanceTimeBy(MAIL_SIGNALS_PREVIEW_DELAY_MILLIS - 1)
        vm.onAction(ProjectMailSignalsAction.Remove(MailSignalField.DOMAINS, "novak.cz"))
        advanceTimeBy(MAIL_SIGNALS_PREVIEW_DELAY_MILLIS - 1)
        runCurrent()
        assertEquals(emptyList(), repository.previews)

        repository.preview = { preview("t3") }
        advanceTimeBy(1)
        runCurrent()
        val sent = MailSignalSet(keywords = listOf("Faktura", "smlouva"))
        assertEquals(listOf<MailSignalSet?>(sent), repository.previews)
        assertEquals(MailSignalsPreviewPhase.READY, vm.state.value.preview.phase)
        assertEquals(listOf(item("t3")), vm.state.value.preview.threads)
        vm.close()
    }

    @Test fun `lists changed back to the saved ones preview the saved signals`() = runTest(dispatcher) {
        val vm = ready()
        repository.previews.clear()
        vm.type(MailSignalField.KEYWORDS, "smlouva")
        vm.onAction(ProjectMailSignalsAction.Remove(MailSignalField.KEYWORDS, "smlouva"))
        settle()
        assertEquals(listOf<MailSignalSet?>(null), repository.previews)
        assertFalse(vm.state.value.unsaved)
        assertTrue(vm.state.value.canAssign)
        vm.close()
    }

    @Test fun `a newer preview supersedes one that has not answered`() = runTest(dispatcher) {
        val gate = CompletableDeferred<Unit>()
        repository.preview = {
            withContext(NonCancellable) { gate.await() }
            preview("stale")
        }
        val vm = ready()
        repository.preview = { preview("t9") }
        vm.type(MailSignalField.KEYWORDS, "smlouva")
        settle()
        gate.complete(Unit)
        runCurrent()
        assertEquals(listOf(item("t9")), vm.state.value.preview.threads)
        vm.close()
    }

    @Test fun `a failed preview is shown and retried`() = runTest(dispatcher) {
        val failures = listOf<suspend (MailSignalSet?) -> RepositoryResult<MailSignalsOutcome<MailSignalPreview>>>(
            { RepositoryResult.Failure(FailureKind.UNAVAILABLE) },
            { error("unexpected") },
        )
        failures.zip(listOf(FailureKind.UNAVAILABLE, null)).forEach { (answer, kind) ->
            repository.preview = answer
            val vm = ready()
            assertEquals(MailSignalsPreviewPhase.ERROR, vm.state.value.preview.phase)
            assertEquals(kind, vm.state.value.preview.failure)
            assertFalse(vm.state.value.canAssign)
            repository.preview = { preview("t1") }
            vm.onAction(ProjectMailSignalsAction.RetryPreview)
            runCurrent()
            assertEquals(listOf(item("t1")), vm.state.value.preview.threads)
            vm.close()
        }
    }

    @Test fun `a draft the server refuses marks the list it names`() = runTest(dispatcher) {
        val vm = ready()
        repository.preview = { RepositoryResult.Content(MailSignalsOutcome.Invalid(MailSignalField.ADDRESSES)) }
        vm.type(MailSignalField.ADDRESSES, "jana@pekarna.cz")
        settle()
        assertEquals(MailSignalField.ADDRESSES, vm.state.value.invalidField)
        assertEquals(MailSignalsPreviewPhase.ERROR, vm.state.value.preview.phase)
        assertEquals(FailureKind.REJECTED, vm.state.value.preview.failure)
        vm.close()
    }

    // MARK: Save

    @Test fun `saving puts the lists and takes the server's normalization and previews the saved signals`() =
        runTest(dispatcher) {
            val vm = ready()
            vm.type(MailSignalField.DOMAINS, "pekárna.cz")
            repository.save = {
                val normalized = it.copy(domains = listOf("novak.cz", "xn--pekrna-bva.cz"))
                RepositoryResult.Content(MailSignalsOutcome.Done(project(normalized)))
            }
            repository.previews.clear()
            vm.onAction(ProjectMailSignalsAction.Save)
            assertTrue(vm.state.value.saving)
            assertFalse(vm.state.value.canSave)
            runCurrent()

            val sent = MailSignalSet(listOf("novak.cz", "pekárna.cz"), emptyList(), listOf("Faktura"))
            assertEquals(listOf(sent), repository.saves)
            assertEquals(listOf("novak.cz", "xn--pekrna-bva.cz"), vm.state.value.domains)
            assertFalse(vm.state.value.saving)
            assertFalse(vm.state.value.unsaved)
            assertEquals(listOf<MailSignalSet?>(null), repository.previews, "The saved signals are previewed at once")
            assertTrue(vm.state.value.canAssign)
            vm.close()
        }

    @Test fun `a change made while saving stays unsaved`() = runTest(dispatcher) {
        val gate = CompletableDeferred<Unit>()
        val vm = ready()
        vm.type(MailSignalField.KEYWORDS, "smlouva")
        repository.save = {
            gate.await()
            RepositoryResult.Content(MailSignalsOutcome.Done(project(it)))
        }
        vm.onAction(ProjectMailSignalsAction.Save)
        runCurrent()
        vm.type(MailSignalField.KEYWORDS, "dodatek")
        gate.complete(Unit)
        runCurrent()
        assertEquals(listOf("Faktura", "smlouva", "dodatek"), vm.state.value.keywords)
        assertTrue(vm.state.value.unsaved)
        assertTrue(vm.state.value.canSave)
        vm.close()
    }

    @Test fun `a save refused for a list marks it and keeps the lists unsaved`() = runTest(dispatcher) {
        val vm = ready()
        vm.type(MailSignalField.KEYWORDS, "smlouva")
        repository.save = { RepositoryResult.Content(MailSignalsOutcome.Invalid(MailSignalField.KEYWORDS)) }
        vm.onAction(ProjectMailSignalsAction.Save)
        runCurrent()
        assertEquals(MailSignalField.KEYWORDS, vm.state.value.invalidField)
        assertTrue(vm.state.value.unsaved)
        assertTrue(vm.state.value.canSave)
        assertNull(vm.state.value.saveFailure)
        vm.close()
    }

    @Test fun `a failed save is shown until dismissed`() = runTest(dispatcher) {
        val failures = listOf<suspend (MailSignalSet) -> RepositoryResult<MailSignalsOutcome<ProjectMailSignals>>>(
            { RepositoryResult.Failure(FailureKind.UNAVAILABLE) },
            { error("unexpected") },
        )
        failures.zip(listOf(FailureKind.UNAVAILABLE, null)).forEach { (answer, kind) ->
            val vm = ready()
            vm.type(MailSignalField.KEYWORDS, "smlouva")
            repository.save = answer
            vm.onAction(ProjectMailSignalsAction.Save)
            runCurrent()
            assertEquals(Failed(kind), vm.state.value.saveFailure)
            assertTrue(vm.state.value.unsaved)
            vm.onAction(ProjectMailSignalsAction.DismissFailure)
            assertNull(vm.state.value.saveFailure)
            vm.close()
        }
    }

    @Test fun `saved lists are not saved again`() = runTest(dispatcher) {
        val vm = ready()
        vm.onAction(ProjectMailSignalsAction.Save)
        runCurrent()
        assertEquals(emptyList(), repository.saves)
        vm.close()
    }

    // MARK: Assign

    @Test fun `assigning takes the threads of a fresh preview of the saved signals`() = runTest(dispatcher) {
        val vm = ready()
        repository.previews.clear()
        repository.preview = { preview("t1", "t2", "t3") }
        vm.onAction(ProjectMailSignalsAction.Assign)
        assertTrue(vm.state.value.assigning)
        assertFalse(vm.state.value.canAssign)
        repository.apply = {
            repository.preview = { preview("t4") }
            RepositoryResult.Content(MailSignalAssignment(assigned = 2, skipped = 1))
        }
        runCurrent()

        assertEquals(listOf(listOf("t1", "t2", "t3")), repository.applies)
        assertEquals(listOf<MailSignalSet?>(null, null), repository.previews, "Before and after the assignment")
        assertEquals(MailSignalsAssignment(assigned = 2, skipped = 1), vm.state.value.assignment)
        assertFalse(vm.state.value.assigning)
        assertEquals(listOf(item("t4")), vm.state.value.preview.threads)
        vm.onAction(ProjectMailSignalsAction.DismissAssignment)
        assertNull(vm.state.value.assignment)
        vm.close()
    }

    @Test fun `unsaved lists are saved before anything is assigned`() = runTest(dispatcher) {
        val vm = ready()
        vm.type(MailSignalField.KEYWORDS, "smlouva")
        settle()
        assertFalse(vm.state.value.canAssign)
        vm.onAction(ProjectMailSignalsAction.Assign)
        runCurrent()
        assertEquals(emptyList(), repository.applies)
        assertFalse(vm.state.value.assigning)
        vm.close()
    }

    @Test fun `a fresh preview without threads assigns nothing`() = runTest(dispatcher) {
        val vm = ready()
        repository.preview = { preview() }
        vm.onAction(ProjectMailSignalsAction.Assign)
        runCurrent()
        assertEquals(emptyList(), repository.applies)
        assertEquals(MailSignalsAssignment(assigned = 0, skipped = 0), vm.state.value.assignment)
        assertFalse(vm.state.value.canAssign)
        vm.close()
    }

    private class AssignFailure(
        val fresh: suspend (MailSignalSet?) -> RepositoryResult<MailSignalsOutcome<MailSignalPreview>>,
        val apply: suspend (List<String>) -> RepositoryResult<MailSignalAssignment>,
        val failed: Failed,
        val applied: Boolean,
    )

    @Test fun `a failed fresh preview or assignment is shown`() = runTest(dispatcher) {
        val cases = listOf(
            AssignFailure(
                fresh = { RepositoryResult.Failure(FailureKind.UNAVAILABLE) },
                apply = { RepositoryResult.Content(MailSignalAssignment(1, 0)) },
                failed = Failed(FailureKind.UNAVAILABLE),
                applied = false,
            ),
            AssignFailure(
                fresh = { preview("t1") },
                apply = { RepositoryResult.Failure(FailureKind.NOT_FOUND) },
                failed = Failed(FailureKind.NOT_FOUND),
                applied = true,
            ),
            AssignFailure(
                fresh = { preview("t1") },
                apply = { error("unexpected") },
                failed = Failed(null),
                applied = true,
            ),
        )
        cases.forEach { case ->
            val vm = ready()
            repository.applies.clear()
            repository.preview = case.fresh
            repository.apply = case.apply
            vm.onAction(ProjectMailSignalsAction.Assign)
            runCurrent()
            assertEquals(case.failed, vm.state.value.assignFailure)
            assertNull(vm.state.value.assignment)
            assertFalse(vm.state.value.assigning)
            assertEquals(if (case.applied) listOf(listOf("t1")) else emptyList(), repository.applies)
            vm.onAction(ProjectMailSignalsAction.DismissFailure)
            assertNull(vm.state.value.assignFailure)
            repository.preview = { preview("t1", "t2") }
            vm.close()
        }
    }

    // MARK: Lifetime

    @Test fun `a closed ViewModel ignores actions and a late answer`() = runTest(dispatcher) {
        val gate = CompletableDeferred<Unit>()
        val vm = ready()
        repository.preview = {
            withContext(NonCancellable) { gate.await() }
            preview("late")
        }
        vm.type(MailSignalField.KEYWORDS, "smlouva")
        settle()
        vm.close()
        vm.close()
        assertTrue(vm.isClosed)
        gate.complete(Unit)
        runCurrent()
        val closed = vm.state.value
        assertEquals(listOf(item("t1"), item("t2")), closed.preview.threads)
        vm.type(MailSignalField.KEYWORDS, "dodatek")
        vm.onAction(ProjectMailSignalsAction.Retry)
        runCurrent()
        assertEquals(closed, vm.state.value)
        assertEquals(listOf("p1"), repository.loads)
    }

    @Test fun `clearing the owning store cancels a load without a failure`() = runTest(dispatcher) {
        repository.signals = { awaitCancellation() }
        val store = ViewModelStore()
        val vm = store.provide { ProjectMailSignalsViewModelFactory(repository).viewModel("p1") }
        runCurrent()
        store.clear()
        runCurrent()
        assertTrue(vm.isClosed)
        assertEquals(ProjectMailSignalsState(), vm.state.value)
        vm.onAction(ProjectMailSignalsAction.Retry)
        assertEquals(ProjectMailSignalsState(), vm.state.value)
    }
}
