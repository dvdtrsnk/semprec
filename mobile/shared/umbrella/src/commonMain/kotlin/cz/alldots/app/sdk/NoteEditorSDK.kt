package cz.alldots.app.sdk

import cz.alldots.app.data.AuthenticatedApi
import cz.alldots.app.data.HttpJournalRepository
import cz.alldots.app.data.HttpNotePageRepository
import cz.alldots.app.domain.note.PageChanges
import cz.alldots.app.presentation.NoteEditorSource
import cz.alldots.app.presentation.NoteEditorViewModel
import cz.alldots.app.presentation.NoteEditorViewModelFactory

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
