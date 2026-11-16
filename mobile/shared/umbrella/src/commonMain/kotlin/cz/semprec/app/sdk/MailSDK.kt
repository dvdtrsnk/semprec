package cz.semprec.app.sdk

import cz.semprec.app.data.AuthenticatedApi
import cz.semprec.app.data.HttpMailDraftRepository
import cz.semprec.app.data.HttpMailRepository
import cz.semprec.app.data.HttpMailboxRepository
import cz.semprec.app.presentation.MailAccountViewModel
import cz.semprec.app.presentation.MailAccountsViewModel
import cz.semprec.app.presentation.MailComposeStart
import cz.semprec.app.presentation.MailComposeViewModel
import cz.semprec.app.presentation.MailFoldersViewModel
import cz.semprec.app.presentation.MailListStart
import cz.semprec.app.presentation.MailThreadViewModel
import cz.semprec.app.presentation.MailThreadsViewModel
import cz.semprec.app.presentation.MailViewModelFactory

/** The mail screens; [HomeSDK.mail] hands it out. */
class MailSDK internal constructor(private val factory: MailViewModelFactory) {
    internal constructor(api: AuthenticatedApi) : this(
        MailViewModelFactory(HttpMailRepository(api), HttpMailDraftRepository(api), HttpMailboxRepository(api)),
    )

    /** The thread list that [start] selects. */
    fun threadsViewModel(start: MailListStart): MailThreadsViewModel = factory.threadsViewModel(start)

    fun threadViewModel(threadId: String): MailThreadViewModel = factory.threadViewModel(threadId)

    fun composeViewModel(start: MailComposeStart): MailComposeViewModel = factory.composeViewModel(start)

    fun foldersViewModel(): MailFoldersViewModel = factory.foldersViewModel()

    fun accountsViewModel(): MailAccountsViewModel = factory.accountsViewModel()

    fun accountViewModel(mailboxId: String): MailAccountViewModel = factory.accountViewModel(mailboxId)
}
