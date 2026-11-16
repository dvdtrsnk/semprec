package cz.semprec.app.presentation

import cz.semprec.app.domain.CalendarAgendaRepository
import kotlin.experimental.ExperimentalObjCRefinement
import kotlin.native.HiddenFromObjC

/**
 * Creates the calendar's agenda ViewModels, whose constructor is internal, for the SDK in the umbrella module. Hidden
 * from Objective-C and Swift so that the domain type it takes stays out of the exported native API.
 */
@OptIn(ExperimentalObjCRefinement::class)
@HiddenFromObjC
class CalendarAgendaViewModelFactory(private val repository: CalendarAgendaRepository) {
    /** One new ViewModel per call; the caller owns it. [from] is the first day, `YYYY-MM-DD`. */
    fun calendarAgendaViewModel(from: String): CalendarAgendaViewModel = CalendarAgendaViewModel(from, repository)
}
