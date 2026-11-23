package cz.semprec.app.sdk

import cz.semprec.app.data.AuthenticatedApi
import cz.semprec.app.data.HttpJournalRepository
import cz.semprec.app.data.HttpNotePageRepository
import cz.semprec.app.domain.note.PageChanges
import cz.semprec.app.presentation.NoteEditorSource
import cz.semprec.app.presentation.NoteEditorViewModel
import cz.semprec.app.presentation.NoteEditorViewModelFactory

/**
 * The note editor of [HomeSDK]. Every call creates a new ViewModel that the caller owns; it reads its page again when
 * [pages] names it.
 */
class NoteEditorSDK internal constructor(api: AuthenticatedApi, pages: PageChanges) {
    private val viewModels = HttpJournalRepository(api).let { journal ->
        NoteEditorViewModelFactory(HttpNotePageRepository(api, journal), journal, pages.events)
    }

    fun noteEditorViewModel(source: NoteEditorSource): NoteEditorViewModel = viewModels.noteEditorViewModel(source)
}
