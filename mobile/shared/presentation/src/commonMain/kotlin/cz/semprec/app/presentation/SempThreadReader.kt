package cz.semprec.app.presentation

import cz.semprec.app.core.FailureKind
import cz.semprec.app.domain.GetSempApproval
import cz.semprec.app.domain.ListSempThreads
import cz.semprec.app.domain.LoadSempConversation
import cz.semprec.app.domain.LoadSempStatusSummary
import cz.semprec.app.domain.RepositoryResult
import cz.semprec.app.domain.SempConversation
import cz.semprec.app.domain.SempMessage
import cz.semprec.app.domain.SempStatusSummary
import cz.semprec.app.domain.SempThreadKind
import cz.semprec.app.domain.SempThreadsQuery

/** What opening a chat found: its conversation, or `null` when there is none yet and the first message makes it. */
internal sealed interface SempOpened {
    data class Found(val conversation: SempConversation) : SempOpened

    data object Empty : SempOpened

    data class Failed(val kind: FailureKind?) : SempOpened
}

/** The reads a chat screen makes before and while it shows a conversation. */
internal class SempThreadReader(
    private val loadConversation: LoadSempConversation,
    private val list: ListSempThreads,
    private val summary: LoadSempStatusSummary,
    private val getApproval: GetSempApproval,
) {
    /** Finds the thread [start] names and reads it; a start with no thread to find is [SempOpened.Empty]. */
    suspend fun open(start: SempThreadStart, threadId: String?, inboxItemId: String?): SempOpened = when (start) {
        SempThreadStart.EXISTING -> threadId?.let { read(it) } ?: SempOpened.Failed(FailureKind.NOT_FOUND)
        SempThreadStart.NEW -> SempOpened.Empty
        SempThreadStart.LATEST -> openFirst(SempThreadsQuery(setOf(SempThreadKind.CHAT), limit = 1))
        SempThreadStart.ITEM -> openFirst(
            SempThreadsQuery(setOf(SempThreadKind.ITEM), limit = 1, subjectInboxItemId = inboxItemId),
        )
    }

    private suspend fun openFirst(query: SempThreadsQuery): SempOpened = when (val result = guarded { list(query) }) {
        is RepositoryResult.Content -> result.value.rows.firstOrNull()?.let { read(it.id) } ?: SempOpened.Empty
        is RepositoryResult.Failure -> SempOpened.Failed(result.kind)
        null -> SempOpened.Failed(null)
    }

    suspend fun read(threadId: String): SempOpened = when (val result = guarded { loadConversation(threadId) }) {
        is RepositoryResult.Content -> SempOpened.Found(result.value)
        is RepositoryResult.Failure -> SempOpened.Failed(result.kind)
        null -> SempOpened.Failed(null)
    }

    /** The notice of the status for the main chat; a failed read is no notice. */
    suspend fun notice(): SempStatusSummary? = (guarded { summary() } as? RepositoryResult.Content)?.value

    /**
     * The approval requests the steps of [messages] asked for. A request already [known] that is settled or being
     * decided is kept as it is; any other is read again, keeping the note that the last decision failed, and one that
     * cannot be read is left out.
     */
    suspend fun approvals(
        messages: List<SempMessage>,
        known: Map<String, SempApprovalItem>,
    ): Map<String, SempApprovalItem> {
        val ids = messages.flatMap { message -> message.steps.mapNotNull { it.approvalRequestId } }.distinct()
        val kept = setOf(
            SempDecisionState.EXECUTED,
            SempDecisionState.REJECTED,
            SempDecisionState.CONFLICT,
            SempDecisionState.APPROVING,
            SempDecisionState.REJECTING,
        )
        return ids.mapNotNull { id ->
            val existing = known[id]
            if (existing != null && existing.decision in kept) {
                id to existing
            } else {
                val read = (guarded { getApproval(id) } as? RepositoryResult.Content)?.value
                read?.let { id to it.toItem().carrying(existing) }
            }
        }.toMap()
    }
}

/** A request read again is still pending, so it keeps the note that the last decision on it failed. */
private fun SempApprovalItem.carrying(previous: SempApprovalItem?): SempApprovalItem =
    if (previous != null && decision == SempDecisionState.PENDING) {
        copy(decisionFailed = previous.decisionFailed, decisionFailure = previous.decisionFailure)
    } else {
        this
    }
