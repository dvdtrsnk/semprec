package cz.alldots.app.domain.note

import kotlinx.coroutines.channels.BufferOverflow
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.emptyFlow
import kotlinx.coroutines.flow.merge

/** How many page changes wait for a slow collector before the oldest is dropped. */
private const val WAITING_CHANGES = 16

/**
 * Tells the note editors of a window that a page may have changed, by its item id: the window's sync socket raises
 * every page the server says was written (this device's own writes included), and [elsewhere] adds the pages whose
 * writes the offline layer every window shares merged
 * (docs/adr/2026-11-23-note-edits-merge-three-ways-and-wait-on-the-device.md). Every window has its own instance.
 */
class PageChanges(elsewhere: Flow<String> = emptyFlow()) {
    private val mutable = MutableSharedFlow<String>(
        extraBufferCapacity = WAITING_CHANGES,
        onBufferOverflow = BufferOverflow.DROP_OLDEST,
    )

    /** The item id of each page that changed, in order. */
    val events: Flow<String> = merge(mutable.asSharedFlow(), elsewhere)

    fun changed(itemId: String) {
        mutable.tryEmit(itemId)
    }
}
