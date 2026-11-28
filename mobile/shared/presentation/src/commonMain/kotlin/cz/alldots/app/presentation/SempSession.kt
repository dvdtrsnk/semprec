package cz.alldots.app.presentation

import cz.alldots.app.domain.SempRefInput
import cz.alldots.app.domain.SempRefKind
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlin.experimental.ExperimentalObjCRefinement
import kotlin.native.HiddenFromObjC

/** What kind of object a person drops on the Semp bubble; each has its own icon and colour on screen. */
enum class SempTargetKind {
    TASK,
    EVENT,
    MAIL,
    INBOX,
    JOURNAL,
    PROJECT,
    PERSON,
    COMPANY,
    FILE,
    NOTE,
    RECORDING,
    FINANCE,
    HEALTH,
    RECIPE,
    BOOK,
    MOVIE,
    RUN,
    OTHER,
}

/**
 * The object under the bubble when it is let go: what it is, how it is named, and how the server names it. A target
 * with no [itemId] and [databaseId] (or [runId] for a run, [mailThreadId] for mail) cannot be sent to Semp.
 */
data class SempTarget(
    val kind: SempTargetKind,
    val title: String,
    val meta: String?,
    val itemId: String?,
    val databaseId: String?,
    val mailThreadId: String?,
    val runId: String?,
)

/** An object attached to the next message to Semp. [key] tells two attachments of the same object apart. */
data class SempAttachment(val key: String, val kind: SempTargetKind, val title: String, val meta: String?)

internal enum class SempStaging { ADDED, DUPLICATE, UNSENDABLE }

/**
 * What the bubble and the chat share while a window lives: the objects staged for the next message, and the notices
 * of the status the person already closed. A window has one session, so two windows never stage each other's objects.
 * Only the main thread touches it.
 */
@OptIn(ExperimentalObjCRefinement::class)
@HiddenFromObjC
class SempSession {
    private val refsByKey = mutableMapOf<String, SempRefInput>()
    private val staged = MutableStateFlow<List<SempAttachment>>(emptyList())
    private val closedNotices = MutableStateFlow<Set<String>>(emptySet())

    internal val attachments: StateFlow<List<SempAttachment>> = staged.asStateFlow()
    internal val closed: StateFlow<Set<String>> = closedNotices.asStateFlow()

    /** The references the staged attachments are sent as. */
    internal fun refs(): List<SempRefInput> = staged.value.mapNotNull { refsByKey[it.key] }

    /** Stages [target] for the next message, unless it is already staged or cannot be sent. */
    internal fun stage(target: SempTarget): SempStaging {
        val ref = target.toRef()
        val key = ref?.let { "${it.kind}:${it.id}" }
        return when {
            ref == null || key == null -> SempStaging.UNSENDABLE
            key in refsByKey -> SempStaging.DUPLICATE
            else -> {
                refsByKey[key] = ref
                staged.update { it + SempAttachment(key, target.kind, target.title, target.meta) }
                SempStaging.ADDED
            }
        }
    }

    /** Takes back exactly the attachments named by [keys]; ones staged meanwhile stay. */
    internal fun unstage(keys: Set<String>) {
        keys.forEach { refsByKey.remove(it) }
        staged.update { list -> list.filterNot { it.key in keys } }
    }

    internal fun closeNotice(id: String) {
        closedNotices.update { it + id }
    }
}

private fun SempTarget.toRef(): SempRefInput? = when (kind) {
    SempTargetKind.RUN -> runId?.let { SempRefInput(SempRefKind.AGENT_RUN, it, null) }
    SempTargetKind.MAIL -> mailThreadId?.let { SempRefInput(SempRefKind.MAIL_THREAD, it, null) }
    else -> itemId?.let { id -> databaseId?.let { SempRefInput(SempRefKind.ITEM, id, it) } }
}
