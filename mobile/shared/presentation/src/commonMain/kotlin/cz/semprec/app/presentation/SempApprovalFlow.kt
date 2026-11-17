package cz.semprec.app.presentation

import cz.semprec.app.core.FailureKind
import cz.semprec.app.domain.DecideSempApproval
import cz.semprec.app.domain.GetSempApproval
import cz.semprec.app.domain.RepositoryResult
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.ensureActive

/** What happened to a request while it was being decided. */
internal sealed interface SempApprovalUpdate {
    /** The decision is on its way. */
    data class Deciding(val approve: Boolean) : SempApprovalUpdate

    /** The server answered with the request as it stands. */
    data class Answered(val item: SempApprovalItem) : SempApprovalUpdate

    /** The decision did not go through; [kind] is `null` for an unexpected failure. */
    data class Failed(val kind: FailureKind?) : SempApprovalUpdate
}

private const val SETTLE_POLL_MILLIS = 1_500L
private const val SETTLE_MAX_POLLS = 20

/**
 * Decides one request and then watches it until it was carried out: an approved request is queued first, and the
 * server runs it a moment later, so the answer is read again until it is no longer queued (or a bounded number of
 * times). Every step is reported to [publish], so the screen shows "deciding", "carrying out" and the result.
 */
internal class SempApprovalFlow(private val decide: DecideSempApproval, private val get: GetSempApproval) {

    suspend fun run(approvalId: String, approve: Boolean, publish: (SempApprovalUpdate) -> Unit) {
        publish(SempApprovalUpdate.Deciding(approve))
        val answer = guarded { decide(approvalId, approve) }
        currentCoroutineContext().ensureActive()
        var item = when (val result = answer) {
            is RepositoryResult.Content -> result.value.toItem()
            is RepositoryResult.Failure -> return publish(SempApprovalUpdate.Failed(result.kind))
            null -> return publish(SempApprovalUpdate.Failed(null))
        }
        publish(SempApprovalUpdate.Answered(item))
        var polls = 0
        while (item.decision == SempDecisionState.QUEUED && polls < SETTLE_MAX_POLLS) {
            delay(SETTLE_POLL_MILLIS)
            polls++
            val next = (guarded { get(approvalId) } as? RepositoryResult.Content)?.value?.toItem()
            currentCoroutineContext().ensureActive()
            if (next != null) {
                item = next
                publish(SempApprovalUpdate.Answered(item))
            }
        }
    }
}

/** Applies [update] to [item]: a decision in flight, the answer of the server, or a failure back to pending. */
internal fun SempApprovalItem.after(update: SempApprovalUpdate): SempApprovalItem = when (update) {
    is SempApprovalUpdate.Deciding -> copy(
        decision = if (update.approve) SempDecisionState.APPROVING else SempDecisionState.REJECTING,
        decisionFailed = false,
        decisionFailure = null,
    )
    is SempApprovalUpdate.Answered -> update.item
    is SempApprovalUpdate.Failed -> copy(
        decision = SempDecisionState.PENDING,
        decisionFailed = true,
        decisionFailure = update.kind,
    )
}
