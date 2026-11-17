package cz.semprec.app.presentation

import cz.semprec.app.domain.NotesRepository
import kotlin.experimental.ExperimentalObjCRefinement
import kotlin.native.HiddenFromObjC

/**
 * Creates the notes screen, whose constructor is internal, for the SDK in the umbrella module. Hidden from
 * Objective-C and Swift so that the domain port it takes stays out of the exported native API.
 */
@OptIn(ExperimentalObjCRefinement::class)
@HiddenFromObjC
class NotesViewModelFactory(private val notes: NotesRepository) {
    /** One new ViewModel per call; the caller owns it (see [ScreenViewModel]). */
    fun notesViewModel(itemId: String): NotesViewModel = NotesViewModel(itemId, notes)
}
