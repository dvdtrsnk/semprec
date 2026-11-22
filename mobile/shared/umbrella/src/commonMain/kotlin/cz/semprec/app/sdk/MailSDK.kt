package cz.semprec.app.sdk

import cz.semprec.app.data.AuthenticatedApi
import cz.semprec.app.data.HttpMailContentRepository
import cz.semprec.app.data.HttpMailDraftRepository
import cz.semprec.app.data.HttpMailHistoryRepository
import cz.semprec.app.data.HttpMailRepository
import cz.semprec.app.data.HttpMailboxRepository
import cz.semprec.app.data.ImapMailHistorySource
import cz.semprec.app.domain.IndexMailHistory
import cz.semprec.app.domain.SyncChanges
import cz.semprec.app.presentation.InternetAccountViewModel
import cz.semprec.app.presentation.InternetAccountViewModelFactory
import cz.semprec.app.presentation.InternetAccountsViewModel
import cz.semprec.app.presentation.MailComposeStart
import cz.semprec.app.presentation.MailComposeViewModel
import cz.semprec.app.presentation.MailFoldersViewModel
import cz.semprec.app.presentation.MailListStart
import cz.semprec.app.presentation.MailThreadViewModel
import cz.semprec.app.presentation.MailThreadsViewModel
import cz.semprec.app.presentation.MailViewModelFactory

/** The mail screens and the internet accounts, which are the mailboxes; [HomeSDK.mail] hands it out. */
class MailSDK internal constructor(
    private val factory: MailViewModelFactory,
    private val accounts: InternetAccountViewModelFactory,
) {
    internal constructor(api: AuthenticatedApi, sync: SyncChanges) : this(HttpMailboxRepository(api), api, sync)

    private constructor(mailboxes: HttpMailboxRepository, api: AuthenticatedApi, sync: SyncChanges) : this(
        MailViewModelFactory(
            HttpMailRepository(api),
            HttpMailDraftRepository(api),
            mailboxes,
            HttpMailContentRepository(api),
            api.changes.events,
            sync,
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
