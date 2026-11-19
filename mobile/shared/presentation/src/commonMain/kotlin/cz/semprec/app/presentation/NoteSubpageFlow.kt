package cz.semprec.app.presentation

import cz.semprec.app.domain.PageBlockType
import cz.semprec.app.domain.note.NoteBlock
import cz.semprec.app.domain.note.NotePageRepository
import cz.semprec.app.domain.note.NoteStructure
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch

/**
 * The operations on subpages, which the server performs on the written page: making a subpage out of a block,
 * copying subpages with their trees, opening one and renaming the page itself. Each first writes every waiting
 * change, so the server's blocks are the ones shown, and reads the page again afterwards.
 */
internal class NoteSubpageFlow(
    private val host: FlowHost<NoteEditorState, NoteEditorEffect>,
    private val store: NotePageStore,
    private val pages: NotePageRepository,
    private val newId: () -> String,
) {
    private var job: Job? = null

    fun makeSubpage(blockId: String) {
        val index = store.blocks.indexOfFirst { it.id == blockId }
        val block = store.blocks.getOrNull(index)?.takeIf { it.type != PageBlockType.PAGE } ?: return
        working {
            val itemId = store.persisted() ?: return@working
            val serverIds = when (val info = answer { pages.info(itemId) }) {
                is Answer.Rejected -> return@working fail(info)
                is Answer.Done -> info.value.blockIds
            }
            // The page was just written from these blocks, so the server's blocks are them in the same order.
            val serverId = serverIds.takeIf { it.size == store.blocks.size }?.get(index)
                ?: return@working fail(Answer.Rejected(null))
            val made = answer { pages.subpageFromBlock(itemId, serverId) }
            if (made is Answer.Rejected) return@working fail(made)
            if (!store.refresh()) return@working
            val pageId = store.blocks.getOrNull(index)?.takeIf { it.type == PageBlockType.PAGE }?.pageId
            if (block.plainText.isEmpty() && pageId != null) {
                host.emit(NoteEditorEffect.OpenPage(pageId, "", focusTitle = true))
            }
        }
    }

    /**
     * Copies the blocks after the last of them; a subpage is copied by the server with every page under it, and its
     * copy is then moved next to the other copies.
     */
    fun duplicate(ids: Set<String>) {
        val before = store.blocks
        val copied = before.filter { it.id in ids && it.type == PageBlockType.PAGE }.mapNotNull { it.pageId }
        val last = before.indexOfLast { it.id in ids }
        if (last < 0) return
        val local = NoteStructure.duplicate(before, ids, newId)
        store.change(local)
        working {
            store.persisted() ?: return@working
            for (pageId in copied) {
                val answered = answer { pages.duplicateSubpage(pageId) }
                if (answered is Answer.Rejected) {
                    store.refresh()
                    return@working fail(answered)
                }
            }
            if (store.refresh()) placeCopies(before, last + 1 + local.size - before.size)
        }
    }

    fun open(blockId: String) {
        val block = store.blocks.firstOrNull { it.id == blockId && it.type == PageBlockType.PAGE } ?: return
        val pageId = block.pageId ?: return
        store.flush()
        host.emit(NoteEditorEffect.OpenPage(pageId, block.plainText, focusTitle = false))
    }

    fun rename(title: String) {
        val itemId = store.itemId ?: return
        if (!host.state.titleEditable || title == host.state.title) return
        working {
            when (val renamed = answer { pages.rename(itemId, title) }) {
                is Answer.Rejected -> fail(renamed)
                is Answer.Done -> host.update { it.copy(title = title) }
            }
        }
    }

    /** Moves the subpage copies the server made (pages [before] did not have) to [at] among the other blocks. */
    private fun placeCopies(before: List<NoteBlock>, at: Int) {
        val known = before.mapNotNull { it.pageId }.toSet()
        val (copies, rest) = store.blocks.partition { it.type == PageBlockType.PAGE && it.pageId !in known }
        val index = at.coerceAtMost(rest.size)
        val placed = rest.take(index) + copies + rest.drop(index)
        if (placed != store.blocks) store.change(placed)
    }

    /** Runs one operation at a time, and none while the page is not shown. */
    private fun working(operation: suspend () -> Unit) {
        if (host.state.phase != NoteEditorPhase.CONTENT || job?.isActive == true) return
        host.update { it.copy(working = true) }
        job = host.scope.launch {
            operation()
            host.update { it.copy(working = false) }
        }
    }

    private fun fail(rejected: Answer.Rejected) = host.update { it.failed(rejected.kind) }
}
