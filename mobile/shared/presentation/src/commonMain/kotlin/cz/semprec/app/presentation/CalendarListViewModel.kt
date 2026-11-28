package cz.semprec.app.presentation

import androidx.lifecycle.viewModelScope
import cz.semprec.app.core.FailureKind
import cz.semprec.app.domain.CalendarCatalogRepository
import cz.semprec.app.domain.CalendarChanges
import cz.semprec.app.domain.CalendarEdit
import cz.semprec.app.domain.CalendarInfo
import cz.semprec.app.domain.CalendarKind
import cz.semprec.app.domain.EditCalendars
import cz.semprec.app.domain.InternetAccount
import cz.semprec.app.domain.InternetAccountRepository
import cz.semprec.app.domain.RepositoryResult
import cz.semprec.app.domain.SyncAccountCalendars
import kotlinx.coroutines.Job
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.launch

/** The colours a calendar or a choice of a property can take, in the order they are offered. */
internal val CALENDAR_SWATCHES: List<CalendarSwatch> = listOf(
    CalendarSwatch("red", "#FF3B30"),
    CalendarSwatch("orange", "#FF9500"),
    CalendarSwatch("yellow", "#FFCC00"),
    CalendarSwatch("green", "#34C759"),
    CalendarSwatch("teal", "#30B0C7"),
    CalendarSwatch("blue", "#007AFF"),
    CalendarSwatch("indigo", "#5856D6"),
    CalendarSwatch("purple", "#AF52DE"),
    CalendarSwatch("pink", "#FF2D55"),
    CalendarSwatch("brown", "#A2845E"),
    CalendarSwatch("gray", "#8E8E93"),
)

private fun initialListState() = CalendarListState(
    phase = CalendarListPhase.LOADING,
    failure = null,
    calendars = emptyList(),
    accounts = emptyList(),
    swatches = CALENDAR_SWATCHES,
    detailId = null,
    impact = null,
    busy = false,
    problem = false,
    problemFailure = null,
)

/**
 * The calendars sheet: which calendars show, their colours and notifications, and adding and removing calendars.
 * Every change is written at once and the list is read again, so the sheet shows what the server has; a calendar the
 * server refuses to change is not changed here either. Deleting asks the server what it would cancel first. A change
 * the server reports ([serverChanges]) reads the list again unless a read or a write of the sheet is under way.
 *
 * The calendars of internet accounts are shown under their account, whose name, provider and calendar status are read
 * from [accounts] with the list; when they cannot be read, the calendars are still shown. Pulling the list to refresh
 * also asks for the accounts' calendars to be synced ([syncAccounts]).
 */
class CalendarListViewModel internal constructor(
    private val repository: CalendarCatalogRepository,
    private val edits: EditCalendars,
    private val changes: CalendarChanges,
    serverChanges: Flow<Unit>,
    private val accounts: InternetAccountRepository,
    private val syncAccounts: SyncAccountCalendars,
) : ScreenViewModel<CalendarListState, CalendarListAction, CalendarListEffect>(initialListState()) {
    private var infos: List<CalendarInfo> = emptyList()
    private var job: Job? = null
    private var seenRevision = changes.revision.value

    init {
        load()
        reloadOnChanges(serverChanges) { if (job?.isActive != true) load() }
        viewModelScope.launch {
            changes.revision.collect { revision ->
                if (revision != seenRevision) {
                    seenRevision = revision
                    load()
                }
            }
        }
    }

    override fun onAction(action: CalendarListAction) {
        if (isClosed) return
        when (action) {
            CalendarListAction.Retry -> load()
            CalendarListAction.Refresh -> refresh()
            is CalendarListAction.Change -> change(action)
            is CalendarListAction.SetAllHidden -> setAllHidden(action.hidden)
            is CalendarListAction.OpenDetail -> update { it.copy(detailId = action.calendarId) }
            CalendarListAction.CloseDetail -> update { it.copy(detailId = null) }
            is CalendarListAction.Add -> add(action.name)
            is CalendarListAction.RequestDelete -> requestDelete(action.calendarId)
            CalendarListAction.ConfirmDelete -> confirmDelete()
            CalendarListAction.CancelDelete -> update { it.copy(impact = null) }
            CalendarListAction.OpenSleep -> emit(CalendarListEffect.OpenSleep)
            CalendarListAction.DismissProblem -> update { it.copy(problem = false, problemFailure = null) }
        }
    }

    private fun change(action: CalendarListAction.Change) {
        val calendar = infos.withId(action.calendarId) ?: return
        run { edits.edit(calendar, action.toEdit(calendar)) }
    }

    private fun load() {
        job?.cancel()
        if (infos.isEmpty()) update { it.copy(phase = CalendarListPhase.LOADING, failure = null) }
        job = viewModelScope.launch {
            val result = guarded { repository.calendars() }
            ensureActive()
            when (result) {
                is RepositoryResult.Content -> {
                    val hasAccounts = result.value.any { it.kind == CalendarKind.ACCOUNT }
                    val known = if (hasAccounts) accounts.accountsOrNone() else null
                    ensureActive()
                    show(result.value, known)
                }
                is RepositoryResult.Failure -> failed(result.kind)
                null -> failed(null)
            }
        }
    }

    /** Asks for the accounts' calendars to be synced and reads the list again, unless a read or a write runs. */
    private fun refresh() {
        requestAccountSync(syncAccounts)
        if (job?.isActive != true) load()
    }

    private fun show(calendars: List<CalendarInfo>, known: List<InternetAccount>?) {
        infos = calendars
        update {
            it.copy(
                phase = CalendarListPhase.CONTENT,
                failure = null,
                calendars = calendars.map { calendar -> calendar.toRow() },
                accounts = sectionsOf(calendars, known.orEmpty()),
                busy = false,
                detailId = it.detailId?.takeIf { id -> calendars.any { calendar -> calendar.id == id } },
            )
        }
    }

    private fun failed(kind: FailureKind?) {
        update {
            if (infos.isEmpty()) {
                it.copy(phase = CalendarListPhase.ERROR, failure = kind, busy = false)
            } else {
                it.copy(busy = false, problem = true, problemFailure = kind)
            }
        }
    }

    private fun setAllHidden(hidden: Boolean) {
        val targets = infos.filter { it.hidden != hidden }
        if (targets.isEmpty()) return
        run {
            val results = targets.map { edits.edit(it, CalendarEdit(hidden = hidden)) }
            results.firstOrNull { it is RepositoryResult.Failure } ?: RepositoryResult.Content(Unit)
        }
    }

    private fun add(name: String) {
        val used = infos.map { it.color.uppercase() }.toSet()
        val color = (CALENDAR_SWATCHES.firstOrNull { it.hex !in used } ?: CALENDAR_SWATCHES.first()).hex
        run(then = { id -> update { it.copy(detailId = id) } }) { edits.create(name, color) }
    }

    private fun requestDelete(id: String) {
        val calendar = infos.withId(id)
        if (calendar == null || calendar.kind != CalendarKind.OWN || calendar.isDefault) return
        job?.cancel()
        job = viewModelScope.launch {
            val result = guarded { repository.cancellationImpact(id) }
            ensureActive()
            when (result) {
                is RepositoryResult.Content -> update {
                    val impact = result.value
                    val shown = CalendarImpact(id, impact.eventCount, impact.recipientCount, impact.cancellationCount)
                    it.copy(impact = shown)
                }
                is RepositoryResult.Failure -> failed(result.kind)
                null -> failed(null)
            }
        }
    }

    private fun confirmDelete() {
        val impact = state.value.impact ?: return
        val calendar = infos.withId(impact.calendarId) ?: return
        update { it.copy(impact = null, detailId = null) }
        run { edits.delete(calendar) }
    }

    /** Runs a write and reads the list again; [then] sees what the write answered, for example a new id. */
    private fun <T> run(then: (T) -> Unit = {}, operation: suspend () -> RepositoryResult<T>) {
        if (state.value.busy) return
        update { it.copy(busy = true, problem = false, problemFailure = null) }
        job?.cancel()
        job = viewModelScope.launch {
            val result = guarded(operation)
            ensureActive()
            when (result) {
                is RepositoryResult.Content -> {
                    then(result.value)
                    load()
                }
                is RepositoryResult.Failure -> failed(result.kind)
                null -> failed(null)
            }
        }
    }
}

/** What a change to one calendar writes: the field it names, from the calendar as it is now. */
private fun CalendarListAction.Change.toEdit(calendar: CalendarInfo): CalendarEdit = when (this) {
    is CalendarListAction.Change.ToggleHidden -> CalendarEdit(hidden = !calendar.hidden)
    is CalendarListAction.Change.Rename -> CalendarEdit(name = name)
    is CalendarListAction.Change.SetColor -> CalendarEdit(color = color)
    is CalendarListAction.Change.SetNotify -> CalendarEdit(notify = notify)
    is CalendarListAction.Change.UseRemoteColor -> CalendarEdit(useRemoteColor = true)
}

private fun List<CalendarInfo>.withId(id: String): CalendarInfo? = firstOrNull { it.id == id }

/** The internet accounts, or `null` when they could not be read; the sections then show no names. */
private suspend fun InternetAccountRepository.accountsOrNone(): List<InternetAccount>? =
    (guarded { accounts() } as? RepositoryResult.Content)?.value

/**
 * One section per account that has calendars in the list: the accounts in the order they are read, then any account
 * the list names that was not among them. Calendars whose account the server did not name share one last section,
 * whose id is empty.
 */
private fun sectionsOf(calendars: List<CalendarInfo>, known: List<InternetAccount>): List<CalendarAccountSection> {
    val ids = calendars.filter { it.kind == CalendarKind.ACCOUNT }.map { it.accountId.orEmpty() }.distinct()
    val byId = known.associateBy { it.mailbox.id }
    val order = known.map { it.mailbox.id }.filter { it in ids } + ids.filter { it !in byId }
    return order.map { id ->
        val account = byId[id]
        CalendarAccountSection(
            id = id,
            name = account?.mailbox?.name,
            provider = account?.mailbox?.provider,
            status = account?.calendarService(),
            address = account?.mailbox?.primaryAddress,
        )
    }
}

private fun CalendarInfo.toRow(): CalendarRow = CalendarRow(
    id = id,
    name = name,
    color = color,
    hidden = hidden,
    notify = notify,
    group = when (kind) {
        CalendarKind.OWN -> CalendarGroup.OWN
        CalendarKind.SYSTEM -> CalendarGroup.SYSTEM
        CalendarKind.SUBSCRIPTION -> CalendarGroup.SUBSCRIPTION
        CalendarKind.ACCOUNT -> CalendarGroup.ACCOUNT
    },
    systemKey = systemKey,
    isDefault = isDefault,
    canRename = kind == CalendarKind.OWN || kind == CalendarKind.ACCOUNT,
    canDelete = kind == CalendarKind.OWN && !isDefault,
    accountId = accountId.orEmpty().takeIf { kind == CalendarKind.ACCOUNT },
    readOnly = readOnly,
    remoteName = remoteName,
    remoteColor = remoteColor,
    usesRemoteColor = usesRemoteColor,
)
