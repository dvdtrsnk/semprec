package cz.alldots.app.presentation

import cz.alldots.app.domain.CollectionReads
import kotlinx.coroutines.Job
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.launch
import kotlin.io.encoding.Base64
import kotlin.io.encoding.ExperimentalEncodingApi

/** A file of the item downloaded for a full preview; its bytes reach the app as Base64 text. */
internal class ItemPreviewFlow(
    private val host: FlowHost<ItemState, ItemEffect>,
    private val reads: CollectionReads,
) {
    private var job: Job? = null

    fun handle(action: ItemAction.Preview) {
        when (action) {
            is ItemAction.Preview.Load -> load(action.propertyKey)
            ItemAction.Preview.Close -> {
                job?.cancel()
                host.update { it.copy(preview = null) }
            }
        }
    }

    @OptIn(ExperimentalEncodingApi::class)
    private fun load(propertyKey: String) {
        val blob = host.state.fields.firstOrNull { it.propertyKey == propertyKey }?.content as? FieldContent.Blob
            ?: return
        job?.cancel()
        host.update {
            it.copy(preview = PreviewView(blob.blobId, blob.filename, blob.mimeType, PreviewStatus.LOADING, null, null))
        }
        job = host.scope.launch {
            val answered = answer { reads.blob(blob.blobId) }
            ensureActive()
            host.update { state ->
                val shown = state.preview ?: return@update state
                when (answered) {
                    is Answer.Rejected ->
                        state.copy(preview = shown.copy(status = PreviewStatus.ERROR, failure = answered.kind))
                    is Answer.Done -> state.copy(
                        preview = shown.copy(
                            status = PreviewStatus.READY,
                            base64 = Base64.encode(answered.value.bytes),
                            mimeType = answered.value.mimeType,
                        ),
                    )
                }
            }
        }
    }
}
