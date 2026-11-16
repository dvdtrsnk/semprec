package cz.semprec.app.presentation

import cz.semprec.app.core.FailureKind
import cz.semprec.app.domain.DecideInboxCard
import cz.semprec.app.domain.EditInboxCard
import cz.semprec.app.domain.InboxDecisions
import cz.semprec.app.domain.InboxRepository
import cz.semprec.app.domain.LoadInbox

/** What the Inbox needs from the domain; the factory of the ViewModel builds it. */
internal class InboxDependencies(
    val load: LoadInbox,
    val edit: EditInboxCard,
    val decide: DecideInboxCard,
    val repository: InboxRepository,
    val decisions: InboxDecisions,
)

/**
 * What the flows of the Inbox share: the host (state and effects of the ViewModel), the model, the dependencies, and
 * the two things a flow asks of the screen, to show the model again and to read the stack again.
 */
internal class InboxFlowContext(
    val host: FlowHost<InboxState, InboxEffect>,
    val model: InboxModel,
    val deps: InboxDependencies,
    val reload: () -> Unit,
) {
    /** Shows what the model holds; the rest of the state (phase, toast, problem) is the flows' to set. */
    fun render(change: (InboxState) -> InboxState = { it }) = host.update {
        change(
            it.copy(
                cards = model.cardStates(),
                picker = model.pickerState(),
                canUndo = model.decisions.isNotEmpty(),
                handled = model.handled,
                dropped = model.dropped,
            ),
        )
    }

    /** A write failed: say so, and read the stack again, because the card may not be what the screen shows. */
    fun failed(problem: InboxProblem, kind: FailureKind?) {
        render { it.copy(problem = problem, problemFailure = kind, busy = false) }
        reload()
    }
}
