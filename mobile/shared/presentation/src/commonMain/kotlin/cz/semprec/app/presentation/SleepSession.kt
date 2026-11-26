package cz.semprec.app.presentation

import cz.semprec.app.core.FailureKind
import cz.semprec.app.domain.CalendarDay
import cz.semprec.app.domain.EditSleepNight
import cz.semprec.app.domain.EditSleepPlans
import cz.semprec.app.domain.EditSleepSettings
import cz.semprec.app.domain.LoadSleep
import cz.semprec.app.domain.RepositoryResult
import cz.semprec.app.domain.SleepDrafts
import cz.semprec.app.domain.SleepOverview
import cz.semprec.app.domain.SleepRules
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.launch
import kotlin.coroutines.coroutineContext

/** The use cases a [SleepSession] changes sleep data with. */
internal class SleepUseCases(
    val load: LoadSleep,
    val settings: EditSleepSettings,
    val plans: EditSleepPlans,
    val night: EditSleepNight,
)

/**
 * What the sleep sheet knows and does, apart from the ViewModel that hosts it: the loaded overview, the open view,
 * loading, writing and publishing the [SleepState]. The edits that read this state are in `SleepSessionEdits.kt`
 * (settings and navigation) and `SleepSessionDraftEdits.kt` (the drafts of plans and nights).
 * Everything runs on the main thread, in [scope].
 */
internal class SleepSession(
    private val scope: CoroutineScope,
    val nightDay: CalendarDay?,
    private val startOnNight: Boolean,
    val useCases: SleepUseCases,
    private val publishState: (SleepState) -> Unit,
) {
    private var job: Job? = null
    var overview: SleepOverview? = null
    private var phase = SleepPhase.LOADING
    private var loadFailure: FailureKind? = null
    val rootScreen = if (startOnNight && nightDay != null) SleepScreen.NIGHT else SleepScreen.MAIN
    var screen = rootScreen
    var saving = false

    /** The plan being edited or added, until it is confirmed or discarded; a refresh never replaces it. */
    var editor: SleepDraftEdit? = null

    /** The night on the night view, until the view is left or the night is written; a refresh never replaces it. */
    var nightDraft: SleepDraftEdit? = null

    /** Writes of a draft that were asked for while another write ran; they run in turn, none is dropped. */
    private val waiting = ArrayDeque<() -> Unit>()
    private var saveFailed = false
    private var saveFailure: FailureKind? = null

    fun load() {
        job?.cancel()
        waiting.clear()
        phase = SleepPhase.LOADING
        loadFailure = null
        saving = false
        publish()
        job = scope.launch {
            val result = attempt { useCases.load(nightDay) }
            ensureActive()
            when (result) {
                is Attempt.Done -> show(result.value)
                is Attempt.Failed -> {
                    phase = SleepPhase.ERROR
                    loadFailure = result.kind
                }
            }
            publish()
        }
    }

    /** Shows [target]; the night view starts a draft of its night, and leaving it drops what was not written. */
    fun goTo(target: SleepScreen) {
        screen = target
        if (target != SleepScreen.NIGHT) nightDraft = null
        ensureNightDraft()
        publish()
    }

    /** Shows a failure of [kind] (`null` for an unexpected one) that no write caused. */
    fun fail(kind: FailureKind?) {
        saveFailed = true
        saveFailure = kind
        publish()
    }

    fun dismissSaveFailure() {
        saveFailed = false
        saveFailure = null
        publish()
    }

    /**
     * Writes one change and reads the overview again. A refused or failed write keeps the shown overview and sets
     * [SleepState.saveFailure]; [onFailed] undoes what was shown ahead of the write, and [onDone] runs only after a
     * successful write, before the overview is read again. While another write runs, a write that [waits] takes its
     * turn after it and any other is ignored.
     */
    fun <T> write(
        waits: Boolean = false,
        onFailed: () -> Unit = {},
        onDone: (T) -> Unit = {},
        block: suspend () -> RepositoryResult<T>,
    ) {
        if (overview == null) return
        if (saving) {
            if (waits) waiting.addLast { write(true, onFailed, onDone, block) }
            publish()
            return
        }
        saving = true
        saveFailed = false
        saveFailure = null
        publish()
        job = scope.launch {
            val result = attempt(block)
            ensureActive()
            when (result) {
                is Attempt.Done -> {
                    onDone(result.value)
                    refresh()
                }
                is Attempt.Failed -> {
                    onFailed()
                    saveFailed = true
                    saveFailure = result.kind
                    saving = false
                    publish()
                }
            }
            waiting.removeFirstOrNull()?.invoke()
        }
    }

    fun publish() {
        val current = overview
        val base = SleepState(
            phase = phase,
            failure = loadFailure,
            screen = screen,
            isRoot = screen == rootScreen,
            saving = saving,
            saveFailed = saveFailed,
            saveFailure = saveFailure,
        )
        publishState(if (current == null) base else base.withData(current, editor, nightDraft))
    }

    private suspend fun refresh() {
        val result = attempt { useCases.load(nightDay) }
        coroutineContext.ensureActive()
        when (result) {
            is Attempt.Done -> show(result.value)
            is Attempt.Failed -> {
                saveFailed = true
                saveFailure = result.kind
            }
        }
        saving = false
        ensureNightDraft()
        publish()
    }

    private fun show(loaded: SleepOverview) {
        overview = loaded
        phase = SleepPhase.READY
        loadFailure = null
        ensureNightDraft()
    }

    /** The night view always has a draft: the night as the server resolves it, or the plan's, else the base night. */
    private fun ensureNightDraft() {
        val current = overview ?: return
        if (screen == SleepScreen.NIGHT && nightDraft == null) {
            val draft = SleepDrafts.ofNight(current.night, current.plans)
            nightDraft = SleepDraftEdit(planId = null, isNight = true, original = draft, current = draft)
        }
    }
}

private sealed interface Attempt<out T> {
    data class Done<T>(val value: T) : Attempt<T>
    data class Failed(val kind: FailureKind?) : Attempt<Nothing>
}

private suspend fun <T> attempt(block: suspend () -> RepositoryResult<T>): Attempt<T> = try {
    when (val result = block()) {
        is RepositoryResult.Content -> Attempt.Done(result.value)
        is RepositoryResult.Failure -> Attempt.Failed(result.kind)
    }
} catch (cancelled: CancellationException) {
    throw cancelled
} catch (_: Exception) {
    Attempt.Failed(null)
}

private fun SleepState.withData(data: SleepOverview, editing: SleepDraftEdit?, nightEdit: SleepDraftEdit?): SleepState {
    val settings = data.settings
    val plans = data.plans
    val goal = settings.goalMinutes
    return copy(
        enabled = settings.enabled,
        showInCalendar = settings.showInCalendar,
        muteSemp = settings.muteSemp,
        alarmSound = settings.alarmSound.toPresentation(),
        alarmSnooze = settings.alarmSnooze,
        goalMinutes = goal,
        prepReminder = settings.prepReminder,
        prepReminderMinutes = settings.prepReminderMinutes,
        goalOptions = SleepRules.GOALS,
        reminderLeadOptions = SleepRules.REMINDER_LEADS,
        plans = plans.map { it.toItem() },
        night = data.night?.toItem(settings),
        editor = editing?.toState(plans, goal),
        nightDraft = nightEdit?.toState(plans, goal),
    )
}
