package cz.alldots.app.sdk

import cz.alldots.app.data.AuthenticatedApi
import cz.alldots.app.data.HttpMailContentRepository
import cz.alldots.app.data.HttpMailDraftRepository
import cz.alldots.app.data.HttpMailHistoryRepository
import cz.alldots.app.data.HttpMailRepository
import cz.alldots.app.data.HttpMailboxRepository
import cz.alldots.app.data.ImapMailHistorySource
import cz.alldots.app.domain.IndexMailHistory
import cz.alldots.app.domain.MailThreadListCache
import cz.alldots.app.domain.SyncChanges
import cz.alldots.app.presentation.InternetAccountViewModel
import cz.alldots.app.presentation.InternetAccountViewModelFactory
import cz.alldots.app.presentation.InternetAccountsViewModel
import cz.alldots.app.presentation.MailComposeStart
import cz.alldots.app.presentation.MailComposeViewModel
import cz.alldots.app.presentation.MailFoldersViewModel
import cz.alldots.app.presentation.MailListStart
import cz.alldots.app.presentation.MailThreadViewModel
import cz.alldots.app.presentation.MailThreadsViewModel
import cz.alldots.app.presentation.MailViewModelFactory

/** The mail screens and the internet accounts, which are the mailboxes; [HomeSDK.mail] hands it out. */
class MailSDK internal constructor(
    private val factory: MailViewModelFactory,
    private val accounts: InternetAccountViewModelFactory,
) {
    internal constructor(
        api: AuthenticatedApi,
        sync: SyncChanges,
        threadLists: MailThreadListCache,
    ) : this(HttpMailboxRepository(api), HttpMailRepository(api), api, sync, threadLists)

    private constructor(
        mailboxes: HttpMailboxRepository,
        mail: HttpMailRepository,
        api: AuthenticatedApi,
        sync: SyncChanges,
        threadLists: MailThreadListCache,
    ) : this(
        MailViewModelFactory(
            mail,
            mail,
            HttpMailDraftRepository(api),
            mailboxes,
            HttpMailContentRepository(api),
            mail,
            api.changes.events,
            sync,
            threadLists,
        ),
        InternetAccountViewModelFactory(
            mailboxes,
            mailboxes,
            IndexMailHistory(HttpMailHistoryRepository(api), ImapMailHistorySource()),
            sync,
        ),
    )

    /** The thread list that [start] selects. */
    fun threadsViewModel(start: MailListStart): MailThreadsViewModel = factory.threadsViewModel(start)

    fun threadViewModel(threadId: String): MailThreadViewModel = factory.threadViewModel(threadId)

    fun composeViewModel(start: MailComposeStart): MailComposeViewModel = factory.composeViewModel(start)

    fun foldersViewModel(): MailFoldersViewModel = factory.foldersViewModel()

    fun internetAccountsViewModel(): InternetAccountsViewModel = accounts.accountsViewModel()

    fun internetAccountViewModel(accountId: String): InternetAccountViewModel = accounts.accountViewModel(accountId)
}
