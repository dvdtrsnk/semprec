package cz.alldots.app.presentation

import cz.alldots.app.domain.IndexMailHistory
import cz.alldots.app.domain.InternetAccountRepository
import cz.alldots.app.domain.MailboxRepository
import cz.alldots.app.domain.SyncChanges
import cz.alldots.app.domain.SyncTopic
import kotlin.experimental.ExperimentalObjCRefinement
import kotlin.native.HiddenFromObjC

/**
 * Creates the internet account ViewModels, whose constructors are internal, for the SDK in the umbrella module.
 * Hidden from Objective-C and Swift so that the repositories it takes stay out of the exported native API. The
 * screens follow the account changes the server reports through [sync]; an account connected on the list has its
 * history indexed with [indexHistory].
 */
@OptIn(ExperimentalObjCRefinement::class)
@HiddenFromObjC
class InternetAccountViewModelFactory(
    private val accounts: InternetAccountRepository,
    private val mailboxes: MailboxRepository,
    private val indexHistory: IndexMailHistory,
    private val sync: SyncChanges = SyncChanges(),
) {
    /** One new ViewModel per call; the caller owns it (see [ScreenViewModel]). */
    fun accountsViewModel(): InternetAccountsViewModel =
        InternetAccountsViewModel(accounts, mailboxes, indexHistory, sync.changes(SyncTopic.MAIL_ACCOUNTS))

    fun accountViewModel(accountId: String): InternetAccountViewModel =
        InternetAccountViewModel(accountId, accounts, mailboxes, sync.changes(SyncTopic.MAIL_ACCOUNTS))
}
