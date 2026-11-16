package cz.semprec.app.presentation

import cz.semprec.app.domain.MailDraftRepository
import cz.semprec.app.domain.MailRepository
import cz.semprec.app.domain.MailboxRepository
import kotlin.experimental.ExperimentalObjCRefinement
import kotlin.native.HiddenFromObjC

/**
 * Creates the mail ViewModels, whose constructors are internal, for the SDK in the umbrella module. Hidden from
 * Objective-C and Swift so that the repositories it takes stay out of the exported native API.
 */
@OptIn(ExperimentalObjCRefinement::class)
@HiddenFromObjC
class MailViewModelFactory(
    private val mail: MailRepository,
    private val drafts: MailDraftRepository,
    private val mailboxes: MailboxRepository,
) {
    /** One new ViewModel per call; the caller owns it (see [ScreenViewModel]). */
    fun threadsViewModel(start: MailListStart): MailThreadsViewModel = MailThreadsViewModel(mail, mailboxes, start)

    fun threadViewModel(threadId: String): MailThreadViewModel = MailThreadViewModel(threadId, mail, drafts)

    fun composeViewModel(start: MailComposeStart): MailComposeViewModel =
        MailComposeViewModel(start, drafts, mailboxes)

    fun foldersViewModel(): MailFoldersViewModel = MailFoldersViewModel(mail, mailboxes)

    fun accountsViewModel(): MailAccountsViewModel = MailAccountsViewModel(mailboxes)

    fun accountViewModel(mailboxId: String): MailAccountViewModel = MailAccountViewModel(mailboxId, mailboxes)
}
