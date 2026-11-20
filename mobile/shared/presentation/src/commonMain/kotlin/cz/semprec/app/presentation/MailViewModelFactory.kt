package cz.semprec.app.presentation

import cz.semprec.app.domain.MailDraftRepository
import cz.semprec.app.domain.MailRepository
import cz.semprec.app.domain.MailboxRepository
import cz.semprec.app.domain.SyncChanges
import cz.semprec.app.domain.SyncTopic
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.emptyFlow
import kotlin.experimental.ExperimentalObjCRefinement
import kotlin.native.HiddenFromObjC

/**
 * Creates the mail ViewModels, whose constructors are internal, for the SDK in the umbrella module. Hidden from
 * Objective-C and Swift so that the repositories it takes stay out of the exported native API. The mailbox screens
 * follow the mail changes the server reports through [sync].
 */
@OptIn(ExperimentalObjCRefinement::class)
@HiddenFromObjC
class MailViewModelFactory(
    private val mail: MailRepository,
    private val drafts: MailDraftRepository,
    private val mailboxes: MailboxRepository,
    private val changes: Flow<Unit> = emptyFlow(),
    private val sync: SyncChanges = SyncChanges(),
) {
    /** One new ViewModel per call; the caller owns it (see [ScreenViewModel]). */
    fun threadsViewModel(
        start: MailListStart
    ): MailThreadsViewModel = MailThreadsViewModel(mail, mailboxes, start, changes)

    fun threadViewModel(threadId: String): MailThreadViewModel = MailThreadViewModel(threadId, mail, drafts)

    fun composeViewModel(start: MailComposeStart): MailComposeViewModel =
        MailComposeViewModel(start, drafts, mailboxes)

    fun foldersViewModel(): MailFoldersViewModel =
        MailFoldersViewModel(mail, mailboxes, sync.changes(SyncTopic.MAIL_ACCOUNTS))

    fun accountsViewModel(): MailAccountsViewModel =
        MailAccountsViewModel(mailboxes, sync.changes(SyncTopic.MAIL_ACCOUNTS))

    fun accountViewModel(mailboxId: String): MailAccountViewModel =
        MailAccountViewModel(mailboxId, mailboxes, sync.changes(SyncTopic.MAIL_ACCOUNTS))
}
