package cz.semprec.app.presentation

import cz.semprec.app.core.FailureKind
import cz.semprec.app.domain.CalendarDay
import cz.semprec.app.domain.EditSleepNight
import cz.semprec.app.domain.EditSleepPlans
import cz.semprec.app.domain.EditSleepSettings
import cz.semprec.app.domain.LoadSleep
import cz.semprec.app.domain.RepositoryResult
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
 * loading, writing and publishing the [SleepState]. The edits that read this state are in `SleepSessionEdits.kt`.
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
    private val rootScreen = if (startOnNight && nightDay != null) SleepScreen.NIGHT else SleepScreen.MAIN
    var screen = rootScreen
    var planId: String? = null
    var saving = false
    private var saveFailed = false
    private var saveFailure: FailureKind? = null

    fun load() {
        job?.cancel()
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

    fun open(target: SleepScreen, id: String?) {
        val current = overview ?: return
        val allowed = when (target) {
            SleepScreen.PLAN -> current.plans.any { it.id == id }
            SleepScreen.NIGHT -> nightDay != null
            else -> true
        }
        if (!allowed || saving) return
        screen = target
        planId = if (target == SleepScreen.PLAN) id else null
        publish()
    }

    fun back() {
        val previous = when (screen) {
            rootScreen -> null
            SleepScreen.MAIN -> SleepScreen.NIGHT
            else -> SleepScreen.MAIN
        }
        if (previous != null) {
            screen = previous
            planId = null
            publish()
        }
    }

    fun dismissSaveFailure() {
        saveFailed = false
        saveFailure = null
        publish()
    }

    /**
     * Writes one change and reads the overview again. A refused or failed write keeps the shown overview and sets
     * [SleepState.saveFailure]; [onFailed] undoes what was shown ahead of the write, and [onDone] runs only after a
     * successful write, before the overview is read again.
     */
    fun <T> write(
        onFailed: () -> Unit = {},
        onDone: (T) -> Unit = {},
        block: suspend () -> RepositoryResult<T>,
    ) {
        if (saving || overview == null) return
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
        publishState(if (current == null) base else base.withData(current, planId))
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
        publish()
    }

    private fun show(loaded: SleepOverview) {
        overview = loaded
        phase = SleepPhase.READY
        loadFailure = null
        if (planId != null && loaded.plans.none { it.id == planId }) {
            planId = null
            if (screen == SleepScreen.PLAN) screen = SleepScreen.MAIN
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

private fun SleepState.withData(data: SleepOverview, openPlanId: String?): SleepState {
    val settings = data.settings
    val plans = data.plans
    val open = plans.firstOrNull { it.id == openPlanId }
    return copy(
        enabled = settings.enabled,
        showInCalendar = settings.showInCalendar,
        muteSemp = settings.muteSemp,
        alarmSound = settings.alarmSound.toPresentation(),
        alarmSnooze = settings.alarmSnooze,
        goalMinutes = settings.goalMinutes,
        prepReminder = settings.prepReminder,
        prepReminderMinutes = settings.prepReminderMinutes,
        goalOptions = SleepRules.GOALS,
        reminderLeadOptions = SleepRules.REMINDER_LEADS,
        shortestNightMinutes = SleepRules.SHORTEST_NIGHT_MINUTES,
        longestNightMinutes = SleepRules.LONGEST_NIGHT_MINUTES,
        plans = plans.map { it.toItem() },
        selectedPlanId = open?.id,
        night = data.night?.toItem(settings),
        ring = data.ring(screen, open?.id),
        takenDaysByOtherPlans = plans.filter { it.id != open?.id }.flatMap { it.wakeDays }.distinct().sorted(),
        canAddPlan = SleepRules.canAddPlan(plans),
        canDeletePlan = SleepRules.canDeletePlan(plans),
    )
}
