package cz.alldots.app.presentation

import cz.alldots.app.domain.CollectionReads
import cz.alldots.app.domain.CollectionWrites
import kotlinx.coroutines.Job
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.launch

/**
 * The item's page: reads it with its version token, and saves a new Markdown only against the token it read, so a
 * page changed elsewhere in the meantime is refused by the server instead of overwritten.
 */
internal class ItemPageFlow(
    private val host: FlowHost<ItemState, ItemEffect>,
    private val reads: CollectionReads,
    private val writes: CollectionWrites,
    private val itemId: String,
) {
    private var etag: String? = null
    private var job: Job? = null

    fun handle(action: ItemAction.Page) {
        when (action) {
            ItemAction.Page.Reload -> load()
            is ItemAction.Page.Save -> save(action.markdown)
        }
    }

    fun load() = run(null)

    private fun save(markdown: String) {
        if (etag != null) run(markdown)
    }

    /** Reads the page, or saves [markdown] as the new page when it is given. */
    private fun run(markdown: String?) {
        job?.cancel()
        val status = if (markdown == null) PageStatus.LOADING else PageStatus.SAVING
        host.update { it.copy(page = it.page.copy(status = status)) }
        job = host.scope.launch {
            val token = etag
            val answered = answer {
                if (markdown == null || token == null) {
                    reads.page(itemId)
                } else {
                    writes.replacePage(itemId, markdown, token)
                }
            }
            ensureActive()
            when (answered) {
                is Answer.Rejected -> host.update {
                    it.copy(page = it.page.copy(status = PageStatus.ERROR, failure = answered.kind))
                }
                is Answer.Done -> {
                    etag = answered.value.etag
                    host.update { it.copy(page = PageView(PageStatus.READY, answered.value.markdown, null)) }
                }
            }
        }
    }
}
