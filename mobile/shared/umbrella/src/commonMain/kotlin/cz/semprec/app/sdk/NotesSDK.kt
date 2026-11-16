package cz.semprec.app.sdk

import cz.semprec.app.data.AuthenticatedApi
import cz.semprec.app.data.HttpNotesRepository
import cz.semprec.app.presentation.NotesViewModel
import cz.semprec.app.presentation.NotesViewModelFactory

/** The notes screen; [HomeSDK.notes] hands it out. */
class NotesSDK internal constructor(private val factory: NotesViewModelFactory) {

    /** The page of the item [itemId]: a project, an area or a subpage. */
    fun notesViewModel(itemId: String): NotesViewModel = factory.notesViewModel(itemId)

    internal companion object {
        fun create(api: AuthenticatedApi): NotesSDK = NotesSDK(NotesViewModelFactory(HttpNotesRepository(api)))
    }
}
