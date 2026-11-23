package cz.semprec.app.presentation

import cz.semprec.app.domain.JournalRepository
import cz.semprec.app.domain.note.NotePageRepository
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.emptyFlow
import kotlin.experimental.ExperimentalObjCRefinement
import kotlin.native.HiddenFromObjC

/**
 * Creates note editors, whose constructor is internal, for the SDK in the umbrella module. Hidden from Objective-C
 * and Swift so that the domain types it takes stay out of the exported native API.
 */
@OptIn(ExperimentalObjCRefinement::class)
@HiddenFromObjC
class NoteEditorViewModelFactory(
    private val pages: NotePageRepository,
    private val journal: JournalRepository,
    private val pageChanges: Flow<String> = emptyFlow(),
) {
    /** One new ViewModel per call; the caller owns it (see [ScreenViewModel]). */
    fun noteEditorViewModel(source: NoteEditorSource): NoteEditorViewModel =
        NoteEditorViewModel(source, pages, journal, NoteEditorSettings(), pageChanges)
}
