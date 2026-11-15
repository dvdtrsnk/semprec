package cz.semprec.app.presentation

import cz.semprec.app.core.FailureKind
import cz.semprec.app.domain.CollectionDatabase
import cz.semprec.app.domain.CollectionWrites
import kotlinx.coroutines.Job
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.launch
import kotlin.io.encoding.Base64
import kotlin.io.encoding.ExperimentalEncodingApi

/**
 * Adding to the collection: a new item that is opened at once, or an uploaded file that joins the list. Both are
 * attached to what the collection is scoped to, the area of an area collection or the item of a related one.
 */
internal class CollectionWriteFlow(
    private val host: FlowHost<CollectionState, CollectionEffect>,
    private val writes: CollectionWrites,
    private val config: CollectionConfig,
    private val database: () -> CollectionDatabase?,
    private val onUploaded: () -> Unit,
) {
    private var job: Job? = null

    fun handle(action: CollectionAction.Write) {
        when (action) {
            is CollectionAction.Write.Create -> create(action.title.trim())
            is CollectionAction.Write.Upload -> upload(action)
        }
    }

    fun cancel() {
        job?.cancel()
    }

    private fun create(title: String) {
        val target = database() ?: return
        if (title.isEmpty() || job?.isActive == true) return
        host.update { it.copy(creating = true, writeFailure = null) }
        job = host.scope.launch {
            val created = answer { writes.create(target, title, config.relationFor(target)) }
            ensureActive()
            when (created) {
                is Answer.Rejected ->
                    host.update { it.copy(creating = false, writeFailure = Failed(created.kind)) }
                is Answer.Done -> {
                    host.update { it.copy(creating = false) }
                    host.emit(CollectionEffect.OpenItem(created.value.id, target.key))
                }
            }
        }
    }

    @OptIn(ExperimentalEncodingApi::class)
    private fun decode(base64: String): ByteArray? = try {
        Base64.decode(base64)
    } catch (_: IllegalArgumentException) {
        null
    }

    private fun upload(action: CollectionAction.Write.Upload) {
        val target = database()
        if (target == null || job?.isActive == true) return
        val bytes = decode(action.base64)
        if (bytes == null) {
            host.update { it.copy(writeFailure = Failed(FailureKind.INVALID_DATA)) }
            return
        }
        host.update { it.copy(creating = true, writeFailure = null) }
        job = host.scope.launch {
            val saved = answer { writes.upload(action.filename, action.mimeType, bytes, config.relationFor(target)) }
            ensureActive()
            when (saved) {
                is Answer.Rejected ->
                    host.update { it.copy(creating = false, writeFailure = Failed(saved.kind)) }
                is Answer.Done -> {
                    host.update { it.copy(creating = false) }
                    onUploaded()
                }
            }
        }
    }
}
