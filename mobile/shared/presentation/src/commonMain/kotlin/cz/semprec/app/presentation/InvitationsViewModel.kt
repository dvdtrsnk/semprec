package cz.semprec.app.presentation

import androidx.lifecycle.viewModelScope
import cz.semprec.app.core.FailureKind
import cz.semprec.app.domain.AnswerInvitation
import cz.semprec.app.domain.CalendarInvitation
import cz.semprec.app.domain.InvitationAnswer
import cz.semprec.app.domain.InvitationKind
import cz.semprec.app.domain.InvitationRepository
import cz.semprec.app.domain.InvitationStatus
import cz.semprec.app.domain.RepositoryResult
import cz.semprec.app.domain.needsAnswer
import kotlinx.coroutines.Job
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.launch

private fun initialInvitationsState() = InvitationsState(
    phase = InvitationsPhase.LOADING,
    failure = null,
    tab = InvitationsTab.PENDING,
    items = emptyList(),
    pending = 0,
    answering = null,
    problem = false,
    problemFailure = null,
)

/**
 * The invitations: the ones that wait for an answer under New, the answered ones under Done. The first load opens
 * the tab that has something in it. An answer is sent and the list is read again, so an accepted invitation moves
 * to Done with the status the server stored, and the calendar shows its event. A change the server reports
 * ([serverChanges]) reads the list again unless a read or an answer is under way.
 */
class InvitationsViewModel internal constructor(
    private val repository: InvitationRepository,
    private val answer: AnswerInvitation,
    serverChanges: Flow<Unit>,
) : ScreenViewModel<InvitationsState, InvitationsAction, Nothing>(initialInvitationsState()) {
    private var invitations: List<CalendarInvitation> = emptyList()
    private var loadedOnce = false
    private var job: Job? = null

    init {
        load()
        reloadOnChanges(serverChanges) { if (job?.isActive != true) load() }
    }

    override fun onAction(action: InvitationsAction) {
        if (isClosed) return
        when (action) {
            InvitationsAction.Retry -> load()
            is InvitationsAction.ShowTab -> update { it.copy(tab = action.tab, items = itemsOf(action.tab)) }
            is InvitationsAction.Answer -> reply(action.invitationId, action.reply)
            InvitationsAction.DismissProblem -> update { it.copy(problem = false, problemFailure = null) }
        }
    }

    private fun load() {
        job?.cancel()
        if (!loadedOnce) update { it.copy(phase = InvitationsPhase.LOADING, failure = null) }
        job = viewModelScope.launch {
            val result = guarded { repository.invitations() }
            ensureActive()
            when (result) {
                is RepositoryResult.Content -> show(result.value)
                is RepositoryResult.Failure -> failed(result.kind)
                null -> failed(null)
            }
        }
    }

    private fun show(loaded: List<CalendarInvitation>) {
        invitations = loaded
        val pending = loaded.count { it.needsAnswer }
        val firstTab = if (pending > 0) InvitationsTab.PENDING else InvitationsTab.ANSWERED
        val tab = if (loadedOnce) state.value.tab else firstTab
        loadedOnce = true
        update {
            it.copy(
                phase = InvitationsPhase.CONTENT,
                failure = null,
                tab = tab,
                items = itemsOf(tab),
                pending = pending,
                answering = null,
            )
        }
    }

    private fun failed(kind: FailureKind?) {
        update {
            if (loadedOnce) {
                it.copy(answering = null, problem = true, problemFailure = kind)
            } else {
                it.copy(phase = InvitationsPhase.ERROR, failure = kind)
            }
        }
    }

    private fun reply(invitationId: String, reply: InvitationReply) {
        val invitation = invitations.firstOrNull { it.id == invitationId }
        if (invitation == null || state.value.answering != null) return
        update { it.copy(answering = invitationId, problem = false, problemFailure = null) }
        job?.cancel()
        job = viewModelScope.launch {
            val result = guarded { answer(invitation, reply.toAnswer()) }
            ensureActive()
            when (result) {
                is RepositoryResult.Content -> load()
                is RepositoryResult.Failure -> failed(result.kind)
                null -> failed(null)
            }
        }
    }

    private fun itemsOf(tab: InvitationsTab): List<InvitationItem> {
        val shown = invitations.filter { (tab == InvitationsTab.PENDING) == it.needsAnswer }
        return shown.map { it.toItem() }
    }
}

private fun InvitationReply.toAnswer(): InvitationAnswer = when (this) {
    InvitationReply.ACCEPT -> InvitationAnswer.ACCEPT
    InvitationReply.TENTATIVE -> InvitationAnswer.TENTATIVE
    InvitationReply.DECLINE -> InvitationAnswer.DECLINE
    InvitationReply.ACKNOWLEDGE -> InvitationAnswer.ACKNOWLEDGE
}

private fun CalendarInvitation.toItem(): InvitationItem = InvitationItem(
    id = id,
    kind = when (kind) {
        InvitationKind.INVITE -> InvitationItemKind.INVITE
        InvitationKind.SHARED_CALENDAR_NOTICE -> InvitationItemKind.SHARED_CALENDAR_NOTICE
    },
    status = when (status) {
        InvitationStatus.PENDING -> InvitationItemStatus.PENDING
        InvitationStatus.ACCEPTED -> InvitationItemStatus.ACCEPTED
        InvitationStatus.TENTATIVE -> InvitationItemStatus.TENTATIVE
        InvitationStatus.DECLINED -> InvitationItemStatus.DECLINED
        InvitationStatus.ACKNOWLEDGED -> InvitationItemStatus.ACKNOWLEDGED
        InvitationStatus.CANCELLED -> InvitationItemStatus.CANCELLED
    },
    title = title,
    startsAt = startsAt,
    endsAt = endsAt,
    timeZone = timeZone,
    allDay = allDay,
    place = place,
    organizerName = organizerName,
)
