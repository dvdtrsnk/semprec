package cz.alldots.app.presentation

import cz.alldots.app.domain.InboxCard
import cz.alldots.app.domain.InboxDecided
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.withLock

/**
 * The decisions on the top card: approve it, discard it, take the last decision back, and ask Semp to compute a card
 * again or to return it to its own proposal. A decision waits for the writes before it and then goes to the server on the card they left; the card leaves
 * the stack only when the server has taken the decision.
 */
internal class InboxDecisionFlow(private val context: InboxFlowContext) {
    private val model = context.model

    fun handle(action: InboxAction) {
        when (action) {
            InboxAction.Approve -> decide(approve = true)
            InboxAction.Reject -> decide(approve = false)
            InboxAction.Undo -> undo()
            is InboxAction.Recompute -> recompute(action.cardId)
            is InboxAction.Reset -> reset(action.cardId)
            InboxAction.OpenResult -> openResult()
            InboxAction.DismissResult -> context.render { it.copy(result = null) }
            InboxAction.DismissProblem -> context.render { it.copy(problem = null, problemFailure = null) }
            else -> Unit
        }
    }

    private fun decide(approve: Boolean) {
        val top = model.cards.firstOrNull() ?: return
        if (context.host.state.busy) return
        context.render { it.copy(busy = true, problem = null, problemFailure = null) }
        context.host.scope.launch {
            model.lock.withLock {
                val card = model.card(top.id)
                val answer = if (card == null) null else answer { send(card, approve) }
                context.host.scope.ensureActive()
                when (answer) {
                    null -> context.render { it.copy(busy = false) }
                    is Answer.Rejected -> context.failed(InboxProblem.DECISION, answer.kind)
                    is Answer.Done -> decided(top, approve, answer.value)
                }
            }
        }
    }

    private suspend fun send(card: InboxCard, approve: Boolean) = if (approve) {
        context.deps.decide.approve(card, model.answersOf(card.id))
    } else {
        context.deps.decide.reject(card)
    }

    private fun decided(card: InboxCard, approved: Boolean, decided: InboxDecided) {
        if (!decided.removed) {
            // A capture was given its type: it stays, and Semp now computes its proposal.
            context.render { it.copy(busy = false) }
            context.reload()
            return
        }
        model.remove(card.id)
        model.decisions.addLast(InboxDecision(card.id, approved))
        if (approved) model.handled += 1 else model.dropped += 1
        val shown = decided.outcome?.takeIf { approved }
        val result = shown?.let { InboxResultState(it.label, it.databaseKey, it.itemId) }
        context.render { it.copy(busy = false, result = result) }
    }

    private fun undo() {
        val last = model.decisions.lastOrNull() ?: return
        if (context.host.state.busy) return
        context.render { it.copy(busy = true, problem = null, problemFailure = null, result = null) }
        context.host.scope.launch {
            val answer = model.lock.withLock { answer { context.deps.decisions.reopen(last.cardId) } }
            context.host.scope.ensureActive()
            when (answer) {
                is Answer.Rejected -> context.failed(InboxProblem.UNDO, answer.kind)
                is Answer.Done -> {
                    model.decisions.removeLastOrNull()
                    if (last.approved) model.handled -= 1 else model.dropped -= 1
                    context.render { it.copy(busy = false) }
                    context.reload()
                }
            }
        }
    }

    private fun recompute(cardId: String) {
        val card = model.card(cardId) ?: return
        context.host.scope.launch {
            val answer = model.lock.withLock { answer { context.deps.repository.recompute(card) } }
            context.host.scope.ensureActive()
            when (answer) {
                is Answer.Rejected -> context.failed(InboxProblem.RECOMPUTE, answer.kind)
                is Answer.Done -> context.reload()
            }
        }
    }

    private fun reset(cardId: String) {
        val card = model.card(cardId) ?: return
        context.host.scope.launch {
            model.lock.withLock {
                val current = model.card(cardId) ?: card
                val answer = answer { context.deps.repository.reset(current) }
                context.host.scope.ensureActive()
                when (answer) {
                    is Answer.Rejected -> context.failed(InboxProblem.EDIT, answer.kind)
                    is Answer.Done -> {
                        model.replace(answer.value)
                        context.render()
                    }
                }
            }
        }
    }

    private fun openResult() {
        val result = context.host.state.result
        result?.itemId?.let { context.host.emit(InboxEffect.OpenItem(result.databaseKey, it)) }
        context.render { it.copy(result = null) }
    }
}
