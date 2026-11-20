package cz.semprec.app.sdk

import cz.semprec.app.data.AuthenticatedApi
import cz.semprec.app.data.HttpJournalRepository
import cz.semprec.app.data.HttpNotePageRepository
import cz.semprec.app.presentation.NoteEditorSource
import cz.semprec.app.presentation.NoteEditorViewModel
import cz.semprec.app.presentation.NoteEditorViewModelFactory

/** The note editor of [HomeSDK]. Every call creates a new ViewModel that the caller owns. */
class NoteEditorSDK internal constructor(api: AuthenticatedApi) {
    private val viewModels = HttpJournalRepository(api).let { journal ->
        NoteEditorViewModelFactory(HttpNotePageRepository(api, journal), journal)
    }

    fun noteEditorViewModel(source: NoteEditorSource): NoteEditorViewModel = viewModels.noteEditorViewModel(source)
}
