package cz.alldots.app.presentation

import cz.alldots.app.domain.MailContentRepository
import cz.alldots.app.domain.MailDraftRepository
import cz.alldots.app.domain.MailProjectNames
import cz.alldots.app.domain.MailRepository
import cz.alldots.app.domain.MailThreadChangesRepository
import cz.alldots.app.domain.MailThreadListCache
import cz.alldots.app.domain.MailboxRepository
import cz.alldots.app.domain.NoMailThreadListCache
import cz.alldots.app.domain.SyncChanges
import cz.alldots.app.domain.SyncMailThreadList
import cz.alldots.app.domain.SyncTopic
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.emptyFlow
import kotlinx.coroutines.flow.merge
import kotlin.experimental.ExperimentalObjCRefinement
import kotlin.native.HiddenFromObjC

/**
 * Creates the mail ViewModels, whose constructors are internal, for the SDK in the umbrella module. Hidden from
 * Objective-C and Swift so that the repositories it takes stay out of the exported native API. The mailbox screens
 * and the thread list follow the mail changes the server reports through [sync]; the thread list keeps its rows in
 * [threadLists].
 */
@OptIn(ExperimentalObjCRefinement::class)
@HiddenFromObjC
class MailViewModelFactory(
    private val mail: MailRepository,
    private val threadChanges: MailThreadChangesRepository,
    private val drafts: MailDraftRepository,
    private val mailboxes: MailboxRepository,
    private val content: MailContentRepository,
    private val projectNames: MailProjectNames,
    private val changes: Flow<Unit> = emptyFlow(),
    private val sync: SyncChanges = SyncChanges(),
    private val threadLists: MailThreadListCache = NoMailThreadListCache(),
) {
    /** One new ViewModel per call; the caller owns it (see [ScreenViewModel]). */
    fun threadsViewModel(start: MailListStart): MailThreadsViewModel = MailThreadsViewModel(
        mail,
        mailboxes,
        content,
        SyncMailThreadList(mail, threadChanges, threadLists),
        projectNames,
        start,
        changes,
        merge(sync.changes(SyncTopic.MAIL_THREADS), sync.changes(SyncTopic.MAIL_ACCOUNTS)),
    )

    fun threadViewModel(threadId: String): MailThreadViewModel = MailThreadViewModel(threadId, mail, drafts, content)

    fun composeViewModel(start: MailComposeStart): MailComposeViewModel =
        MailComposeViewModel(start, drafts, mailboxes)

    fun foldersViewModel(): MailFoldersViewModel =
        MailFoldersViewModel(mail, mailboxes, sync.changes(SyncTopic.MAIL_ACCOUNTS))
}
