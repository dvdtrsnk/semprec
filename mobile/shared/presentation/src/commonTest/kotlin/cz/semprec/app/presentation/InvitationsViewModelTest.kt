package cz.semprec.app.presentation

import androidx.lifecycle.ViewModelStore
import cz.semprec.app.core.FailureKind
import cz.semprec.app.domain.CalendarInvitation
import cz.semprec.app.domain.InvitationRepository
import cz.semprec.app.domain.InvitationStatus
import cz.semprec.app.domain.RepositoryResult
import cz.semprec.app.domain.SyncChanges
import cz.semprec.app.domain.SyncTopic
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

@OptIn(ExperimentalCoroutinesApi::class)
class InvitationsViewModelTest : MainDispatcherTest() {
    private val repository = FakeInvitationRepository()
    private val sync = SyncChanges()

    private fun viewModel() =
        CalendarViewModelFactory(
            FakeCalendarRepository(),
            FakeCatalogRepository(),
            repository,
            repository.changes,
            ScriptedInternetAccountRepository(),
            sync = sync,
        ).invitationsViewModel()

    private fun TestScope.loaded(): InvitationsViewModel = viewModel().also { runCurrent() }

    private fun TestScope.act(vm: InvitationsViewModel, action: InvitationsAction) {
        vm.onAction(action)
        runCurrent()
    }

    @Test fun `opens on the new invitations and counts the ones that wait`() = runTest(dispatcher) {
        val vm = viewModel()
        assertEquals(InvitationsPhase.LOADING, vm.state.value.phase)
        runCurrent()
        val state = vm.state.value
        assertEquals(InvitationsPhase.CONTENT, state.phase)
        assertEquals(InvitationsTab.PENDING, state.tab)
        assertEquals(listOf("i1", "i2"), state.items.map { it.id })
        assertEquals(2, state.pending)
        assertEquals(InvitationItemKind.SHARED_CALENDAR_NOTICE, state.items[1].kind)
        assertEquals("Office", state.items[0].place)
        assertEquals("Europe/Prague", state.items[0].timeZone)
        vm.close()
    }

    @Test fun `opens on the answered ones when nothing waits`() = runTest(dispatcher) {
        repository.items = repository.items.map { it.copy(status = InvitationStatus.DECLINED) }
        val vm = loaded()
        assertEquals(InvitationsTab.ANSWERED, vm.state.value.tab)
        assertEquals(3, vm.state.value.items.size)
        assertEquals(0, vm.state.value.pending)
        assertEquals(InvitationItemStatus.DECLINED, vm.state.value.items.first().status)
        vm.close()
    }

    @Test fun `the tabs show the pending and the answered invitations`() = runTest(dispatcher) {
        val vm = loaded()
        act(vm, InvitationsAction.ShowTab(InvitationsTab.ANSWERED))
        assertEquals(listOf("i3"), vm.state.value.items.map { it.id })
        assertEquals(InvitationItemStatus.ACCEPTED, vm.state.value.items.single().status)
        act(vm, InvitationsAction.ShowTab(InvitationsTab.PENDING))
        assertEquals(2, vm.state.value.items.size)
        vm.close()
    }

    @Test fun `an answer is sent and the invitation moves to done`() = runTest(dispatcher) {
        val vm = loaded()
        act(vm, InvitationsAction.Answer("i1", InvitationReply.TENTATIVE))
        assertEquals(listOf("list", "respond i1 TENTATIVE", "list"), repository.calls)
        assertEquals(listOf("i2"), vm.state.value.items.map { it.id })
        assertEquals(1, vm.state.value.pending)
        assertNull(vm.state.value.answering)
        act(vm, InvitationsAction.ShowTab(InvitationsTab.ANSWERED))
        assertEquals(InvitationItemStatus.TENTATIVE, vm.state.value.items.first { it.id == "i1" }.status)
        vm.close()
    }

    @Test fun `a notice is acknowledged and not answered with a yes`() = runTest(dispatcher) {
        val vm = loaded()
        act(vm, InvitationsAction.Answer("i2", InvitationReply.ACCEPT))
        assertTrue(vm.state.value.problem)
        assertEquals(FailureKind.REJECTED, vm.state.value.problemFailure)
        act(vm, InvitationsAction.DismissProblem)
        act(vm, InvitationsAction.Answer("i2", InvitationReply.ACKNOWLEDGE))
        assertTrue("respond i2 ACKNOWLEDGE" in repository.calls)
        assertFalse(vm.state.value.problem)
        vm.close()
    }

    @Test fun `an answered or unknown invitation is not answered again`() = runTest(dispatcher) {
        val vm = loaded()
        act(vm, InvitationsAction.Answer("i3", InvitationReply.DECLINE))
        act(vm, InvitationsAction.Answer("nope", InvitationReply.DECLINE))
        assertTrue(repository.calls.none { it.startsWith("respond") })
        assertTrue(vm.state.value.problem)
        vm.close()
    }

    @Test fun `a refused answer is reported and the invitation stays pending`() = runTest(dispatcher) {
        val vm = loaded()
        repository.respondResult = RepositoryResult.Failure(FailureKind.REJECTED)
        act(vm, InvitationsAction.Answer("i1", InvitationReply.ACCEPT))
        assertTrue(vm.state.value.problem)
        assertEquals(FailureKind.REJECTED, vm.state.value.problemFailure)
        assertNull(vm.state.value.answering)
        assertEquals(2, vm.state.value.items.size)
        vm.close()
    }

    @Test fun `a failing first load is an error that a retry recovers`() = runTest(dispatcher) {
        repository.listResult = unavailable
        val vm = loaded()
        assertEquals(InvitationsPhase.ERROR, vm.state.value.phase)
        assertEquals(FailureKind.UNAVAILABLE, vm.state.value.failure)
        repository.listResult = null
        act(vm, InvitationsAction.Retry)
        assertEquals(InvitationsPhase.CONTENT, vm.state.value.phase)
        vm.close()
    }

    @Test fun `an invitation the server reports is listed unless an answer is under way`() = runTest(dispatcher) {
        val vm = loaded()
        repository.items = repository.items + invitation("i4")
        sync.raise(setOf(SyncTopic.CALENDAR, SyncTopic.MAIL_ACCOUNTS))
        runCurrent()
        assertEquals(2, vm.state.value.pending)
        sync.raise(setOf(SyncTopic.INVITATIONS))
        runCurrent()
        assertEquals(3, vm.state.value.pending)
        assertEquals(listOf("i1", "i2", "i4"), vm.state.value.items.map { it.id })

        val gate = CompletableDeferred<Unit>()
        repository.respondGate = gate
        act(vm, InvitationsAction.Answer("i1", InvitationReply.ACCEPT))
        sync.raise(setOf(SyncTopic.INVITATIONS))
        runCurrent()
        assertEquals("i1", vm.state.value.answering)
        assertEquals(2, repository.calls.count { it == "list" })
        gate.complete(Unit)
        runCurrent()
        assertNull(vm.state.value.answering)
        assertEquals(3, repository.calls.count { it == "list" })
        assertEquals(2, vm.state.value.pending)
        vm.close()
    }

    @Test fun `a failing later load keeps the list and reports it`() = runTest(dispatcher) {
        val vm = loaded()
        repository.listResult = unavailable
        act(vm, InvitationsAction.Retry)
        assertEquals(InvitationsPhase.CONTENT, vm.state.value.phase)
        assertTrue(vm.state.value.problem)
        assertEquals(2, vm.state.value.items.size)
        vm.close()
    }

    @Test fun `a thrown exception is an error without a reason`() = runTest(dispatcher) {
        val failing = object : InvitationRepository by repository {
            override suspend fun invitations(): RepositoryResult<List<CalendarInvitation>> = error("boom")
        }
        val vm = CalendarViewModelFactory(
            FakeCalendarRepository(),
            FakeCatalogRepository(),
            failing,
            repository.changes,
            ScriptedInternetAccountRepository(),
        ).invitationsViewModel()
        runCurrent()
        assertEquals(InvitationsPhase.ERROR, vm.state.value.phase)
        assertNull(vm.state.value.failure)
        vm.close()
    }

    @Test fun `closing ignores actions and clearing the store closes it too`() = runTest(dispatcher) {
        val store = ViewModelStore()
        val vm = store.provide { viewModel() }
        runCurrent()
        store.clear()
        assertTrue(vm.isClosed)
        vm.onAction(InvitationsAction.Answer("i1", InvitationReply.ACCEPT))
        runCurrent()
        assertTrue(repository.calls.none { it.startsWith("respond") })
    }
}
