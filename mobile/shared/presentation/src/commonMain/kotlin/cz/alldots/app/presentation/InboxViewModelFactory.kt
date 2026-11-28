package cz.alldots.app.presentation

import cz.alldots.app.domain.DecideInboxCard
import cz.alldots.app.domain.EditInboxCard
import cz.alldots.app.domain.InboxDecisions
import cz.alldots.app.domain.InboxRepository
import cz.alldots.app.domain.LoadInbox
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.emptyFlow
import kotlin.experimental.ExperimentalObjCRefinement
import kotlin.native.HiddenFromObjC

/**
 * Creates the Inbox ViewModel, whose constructor is internal, for the SDK in the umbrella module. Hidden from
 * Objective-C and Swift so that the domain types it takes stay out of the exported native API.
 */
@OptIn(ExperimentalObjCRefinement::class)
@HiddenFromObjC
class InboxViewModelFactory(
    private val repository: InboxRepository,
    private val decisions: InboxDecisions,
    private val changes: Flow<Unit> = emptyFlow(),
) {
    /** One new ViewModel per call; the caller owns it (see [ScreenViewModel]). */
    fun inboxViewModel(): InboxViewModel = InboxViewModel(
        InboxDependencies(
            load = LoadInbox(repository),
            edit = EditInboxCard(repository),
            decide = DecideInboxCard(decisions),
            repository = repository,
            decisions = decisions,
        ),
        changes,
    )
}
