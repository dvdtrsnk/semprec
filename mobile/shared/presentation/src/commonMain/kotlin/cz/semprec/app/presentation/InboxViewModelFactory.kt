package cz.semprec.app.presentation

import cz.semprec.app.domain.DecideInboxCard
import cz.semprec.app.domain.EditInboxCard
import cz.semprec.app.domain.InboxAttachmentFiles
import cz.semprec.app.domain.InboxDecisions
import cz.semprec.app.domain.InboxRepository
import cz.semprec.app.domain.LoadInbox
import cz.semprec.app.domain.OpenInboxAttachment
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
    private val attachments: InboxAttachmentFiles,
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
            openAttachment = OpenInboxAttachment(attachments),
        ),
        changes,
    )
}
