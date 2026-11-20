package cz.semprec.app.presentation

import cz.semprec.app.core.FailureKind
import cz.semprec.app.domain.JournalPeriod
import cz.semprec.app.domain.PageWrite
import cz.semprec.app.domain.note.NoteBlock
import cz.semprec.app.domain.note.NoteDocument
import cz.semprec.app.domain.note.NoteSource
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.delay
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.job
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

/**
 * The blocks of the note and their page on the server. Reading never writes: a Journal period without a page stays
 * without one until its first change. A change is written after a pause in typing, one write at a time, against the
 * version the page was read with; a page changed elsewhere meanwhile is read again and the local change dropped.
 * Only the blocks a change touched are written anew; the others keep the Markdown lines they were read from.
 *
 * Writes run in a scope of their own, which closing the ViewModel does not cancel: a write already sent finishes, and
 * a change still waiting for its pause when the ViewModel closes is written then.
 */
internal class NotePageStore(
    private val host: FlowHost<NoteEditorState, NoteEditorEffect>,
    private val source: NoteEditorSource,
    private val repositories: NoteRepositories,
    private val reads: NoteReads,
    private val newId: () -> String,
    private val settings: NoteEditorSettings,
) {
    var blocks: List<NoteBlock> = emptyList()
        private set
    var itemId: String? = null
        private set
    private var etag: String? = null
    private var saved = ""
    private var origin = NoteSource.NONE

    /** Whether the server holds no block of the page yet: it shows its blocks only once a write put them there. */
    private var serverBlank = true

    /** Counts what changed the blocks or their version, so a read answering after any of it is not applied. */
    private var generation = 0
    private val writes = Mutex()
    private val writer = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private var loadJob: Job? = null
    private var waitJob: Job? = null

    init {
        host.scope.coroutineContext.job.invokeOnCompletion { writer.launch { persist(ensurePage = false) } }
    }

    fun load() {
        loadJob?.cancel()
        waitJob?.cancel()
        host.update { NoteEditorState(titleEditable = (source as? NoteEditorSource.Page)?.titleEditable == true) }
        loadJob = host.scope.launch {
            val answered = reads.fetch()
            ensureActive()
            when (answered) {
                is Answer.Done -> apply(answered.value)
                is Answer.Rejected -> host.update { it.copy(phase = NoteEditorPhase.ERROR, failure = answered.kind) }
            }
        }
    }

    /**
     * Reads the page again in place; nothing happens while a change waits to be written or the page is not shown. An
     * answer is dropped when a change, a write or another read came meanwhile: it may be older than what they left.
     */
    fun reread() {
        if (host.state.phase != NoteEditorPhase.CONTENT || host.state.saving || source is NoteEditorSource.Text) return
        loadJob?.cancel()
        val seen = generation
        loadJob = host.scope.launch {
            val answered = reads.fetch()
            ensureActive()
            if (answered is Answer.Done && generation == seen && !host.state.saving) apply(answered.value)
        }
    }

    /** Shows [next] and writes it after the pause. */
    fun change(next: List<NoteBlock>) {
        blocks = next
        generation++
        val pending = NoteDocument.markdown(next, origin) != saved
        host.update { it.copy(blocks = next.toEditor(), wordCount = NoteDocument.wordCount(next), saving = pending) }
        waitJob?.cancel()
        waitJob = host.scope.launch {
            delay(settings.saveDelayMillis)
            // Typing cancels only the pause: a write already sent may have reached the server, and its new version
            // must be kept.
            writer.launch { persist(ensurePage = false) }
        }
    }

    /** Writes a waiting change at once. */
    fun flush() {
        waitJob?.cancel()
        writer.launch { persist(ensurePage = false) }
    }

    /**
     * Writes every change and makes sure the page exists and the server holds the blocks shown; its item id, or
     * `null` when that failed.
     */
    suspend fun persisted(): String? {
        waitJob?.cancel()
        return if (writer.async { persist(ensurePage = true) }.await()) itemId else null
    }

    /** Reads the page again after the server changed it; `false` when that failed. */
    suspend fun refresh(): Boolean = when (val answered = reads.fetch()) {
        is Answer.Done -> {
            apply(answered.value)
            true
        }
        is Answer.Rejected -> {
            host.update { it.failed(answered.kind) }
            false
        }
    }

    private fun apply(snapshot: NoteSnapshot) {
        generation++
        itemId = snapshot.itemId
        etag = snapshot.etag
        serverBlank = snapshot.markdown.isBlank()
        val read = NoteDocument.parse(snapshot.markdown, newId)
        blocks = read.blocks
        origin = read.source
        saved = NoteDocument.markdown(blocks, origin)
        host.update {
            it.copy(
                phase = NoteEditorPhase.CONTENT,
                failure = null,
                title = snapshot.title,
                blocks = blocks.toEditor(),
                wordCount = NoteDocument.wordCount(blocks),
                lastEditedAt = snapshot.lastEditedAt,
                saving = false,
            )
        }
    }

    private suspend fun persist(ensurePage: Boolean): Boolean = writes.withLock {
        val markdown = NoteDocument.markdown(blocks, origin)
        when {
            source is NoteEditorSource.Text -> {
                if (markdown != saved) host.emit(NoteEditorEffect.TextChanged(markdown))
                saved = markdown
                true
            }
            // A page nobody wrote on shows one empty block the server does not hold; a subpage operation needs it there.
            markdown == saved && !(ensurePage && (itemId == null || serverBlank)) -> true
            else -> write(markdown)
        }
    }

    private suspend fun write(markdown: String): Boolean {
        val id = itemId ?: created()
        val token = etag
        if (id == null || token == null) return false
        return when (val answered = answer { repositories.pages.replace(id, markdown, token) }) {
            is Answer.Rejected -> host.update { it.failed(answered.kind) }.let { false }
            is Answer.Done -> when (val written = answered.value) {
                PageWrite.Conflict -> {
                    if (refresh()) host.update { it.reloaded() }
                    false
                }
                is PageWrite.Saved -> {
                    generation++
                    etag = written.etag
                    saved = markdown
                    serverBlank = markdown.isBlank()
                    host.update {
                        it.copy(saving = NoteDocument.markdown(blocks, origin) != saved, lastEditedAt = settings.now())
                    }
                    true
                }
            }
        }
    }

    /**
     * Creates the page of a Journal period on its first change. A page another device created meanwhile is not
     * written over: it is shown instead.
     */
    private suspend fun created(): String? {
        val period = (source as? NoteEditorSource.Journal)?.let { JournalPeriod(it.kind.toType(), it.period) }
            ?: return null
        val document = when (val made = answer { repositories.journal.ensurePage(period) }) {
            is Answer.Rejected -> made
            is Answer.Done -> reads.document(made.value, "", null)
        }
        return when (document) {
            is Answer.Rejected -> host.update { it.failed(document.kind) }.let { null }
            is Answer.Done -> if (document.value.markdown.isBlank()) {
                itemId = document.value.itemId
                etag = document.value.etag
                itemId
            } else {
                apply(document.value)
                host.update { it.reloaded() }
                null
            }
        }
    }
}

/** The page was read again because it changed elsewhere; editing ends. */
internal fun NoteEditorState.reloaded() =
    copy(problem = NoteEditorProblem.RELOADED, caret = null, caretRequest = caretRequest + 1)

internal fun NoteEditorState.failed(kind: FailureKind?) =
    copy(saving = false, working = false, problem = NoteEditorProblem.FAILED, problemFailure = kind)
