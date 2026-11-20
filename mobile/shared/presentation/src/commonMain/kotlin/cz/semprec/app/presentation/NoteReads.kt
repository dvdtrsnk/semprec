package cz.semprec.app.presentation

import cz.semprec.app.domain.JournalPeriod
import cz.semprec.app.domain.JournalRepository
import cz.semprec.app.domain.note.NotePageRepository

/** What one read of the note gave: its page (none for a Journal period nobody wrote on or for kept text). */
internal data class NoteSnapshot(
    val itemId: String?,
    val etag: String?,
    val markdown: String,
    val title: String,
    val lastEditedAt: String?,
)

/** Where the note editor reads and writes pages. */
internal data class NoteRepositories(val pages: NotePageRepository, val journal: JournalRepository)

/** Reads the note where it lives, without writing anything. */
internal class NoteReads(private val source: NoteEditorSource, repositories: NoteRepositories) {
    private val pages = repositories.pages
    private val journal = repositories.journal

    suspend fun fetch(): Answer<NoteSnapshot> = when (source) {
        is NoteEditorSource.Text -> Answer.Done(NoteSnapshot(null, null, source.markdown, "", null))
        is NoteEditorSource.Page -> page(source.itemId)
        is NoteEditorSource.Journal ->
            when (val period = answer { journal.period(JournalPeriod(source.kind.toType(), source.period)) }) {
                is Answer.Rejected -> period
                is Answer.Done -> period.value.itemId?.let { document(it, "", null) }
                    ?: Answer.Done(NoteSnapshot(null, null, "", "", null))
            }
    }

    suspend fun document(id: String, title: String, lastEditedAt: String?): Answer<NoteSnapshot> =
        when (val document = answer { pages.read(id) }) {
            is Answer.Rejected -> document
            is Answer.Done ->
                Answer.Done(NoteSnapshot(id, document.value.etag, document.value.markdown, title, lastEditedAt))
        }

    private suspend fun page(id: String): Answer<NoteSnapshot> = when (val info = answer { pages.info(id) }) {
        is Answer.Rejected -> info
        is Answer.Done -> document(id, info.value.title, info.value.lastEditedAt)
    }
}
