package cz.alldots.app.presentation

import cz.alldots.app.domain.CalendarDay
import cz.alldots.app.domain.EditSleepNight
import cz.alldots.app.domain.EditSleepPlans
import cz.alldots.app.domain.EditSleepSettings
import cz.alldots.app.domain.LoadSleep
import cz.alldots.app.domain.SleepRepository
import kotlin.experimental.ExperimentalObjCRefinement
import kotlin.native.HiddenFromObjC

/**
 * Creates the sleep ViewModel, whose constructor is internal, for the SDK in the umbrella module. Hidden from
 * Objective-C and Swift so that the domain use cases it takes stay out of the exported native API.
 */
@OptIn(ExperimentalObjCRefinement::class)
@HiddenFromObjC
class SleepViewModelFactory(private val repository: SleepRepository) {
    /**
     * One new ViewModel per call; the caller owns it (see [ScreenViewModel]). [night] is the evening `YYYY-MM-DD` the
     * sheet is about, `null` for none or one that is not a date; with [startOnNight] the sheet opens on that night.
     */
    fun sleepViewModel(night: String?, startOnNight: Boolean): SleepViewModel = SleepViewModel(
        nightDay = night?.let(CalendarDay::parse),
        startOnNight = startOnNight,
        loadSleep = LoadSleep(repository),
        editSettings = EditSleepSettings(repository),
        editPlans = EditSleepPlans(repository),
        editNight = EditSleepNight(repository),
    )
}
