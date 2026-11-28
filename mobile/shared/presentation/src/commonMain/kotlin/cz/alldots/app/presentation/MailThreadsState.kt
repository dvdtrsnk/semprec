package cz.alldots.app.presentation

import cz.alldots.app.core.FailureKind
import cz.alldots.app.core.MailRefusal

enum class MailThreadsPhase { LOADING, CONTENT, ERROR }

/** The quick filter chips; a mailbox chip is chosen with [MailThreadsAction.SelectMailbox] instead. */
enum class MailListFilter { ALL, UNREAD, FLAGGED }

/** One row of the list. The app formats [lastMessageAt] and derives the avatar from the sender. */
data class MailThreadItem(
    val threadId: String,
    val subject: String,
    val lastMessageAt: String,
    val senderName: String,
    val senderAddress: String,
    val senderRelationship: String?,
    val messageCount: Int,
    val preview: String?,
    val hasAttachment: Boolean,
    val unread: Boolean,
    val flagged: Boolean,
    val mailboxNames: List<String>,
    val projectName: String?,
    val companyName: String?,
    val hasSempDraft: Boolean,
)

/** A mailbox chip of the list. */
data class MailMailboxChip(val id: String, val name: String)

/** A mailbox that cannot sync until the person signs in again; [since] is when the last sync failed first. */
data class MailAccountNotice(val id: String, val name: String, val since: String?)

/** A project of the filter sheet with the number of threads it holds. */
data class MailFilterOption(val id: String, val name: String, val color: String?, val count: Int)

/**
 * What the provider search added to a search: [unindexed] hits the mail providers hold that the local index does not
 * have yet, and the mailboxes whose provider search failed, named as the chips name them ([MailMailboxChip.name] is
 * empty for a mailbox the list does not know).
 */
data class MailRemoteSearchSummary(val unindexed: Int, val failedAccounts: List<MailMailboxChip>)

enum class MailFacetsPhase { IDLE, LOADING, READY, ERROR }

/** The filter sheet: the projects with their thread counts, loaded when the list starts and on every change. */
data class MailFacetsState(
    val phase: MailFacetsPhase = MailFacetsPhase.IDLE,
    val projectTotal: Int = 0,
    val projects: List<MailFilterOption> = emptyList(),
)

/**
 * The thread list. [search] is what the server was asked for, [projectName] names the chosen context.
 * A failed first load is [MailThreadsPhase.ERROR]; a failed refresh or "more" keeps the list and raises
 * [actionFailed]. [hasMore] says another page follows; [loadingMore] is `true` while it is fetched. [actionRefusal]
 * names the reason the server gave for refusing a read mark.
 *
 * While [search] is not empty the list is the answer of the mail search, one page over every box, folder and
 * project, narrowed only to the chosen mailbox, and [remoteSearch] says what the provider search added; it is `null`
 * for a list that is not a search.
 *
 * [fromCache] is `true` while the rows are the ones the device kept for this view and the server has not answered
 * yet; a refresh that fails then keeps them and raises [actionFailed].
 */
data class MailThreadsState(
    val phase: MailThreadsPhase = MailThreadsPhase.LOADING,
    val failure: FailureKind? = null,
    val refreshing: Boolean = false,
    val loadingMore: Boolean = false,
    val hasMore: Boolean = false,
    val threads: List<MailThreadItem> = emptyList(),
    val search: String = "",
    val box: MailListBox = MailListBox.INBOX,
    val filter: MailListFilter = MailListFilter.ALL,
    val mailboxId: String? = null,
    val folderId: String? = null,
    val projectId: String? = null,
    val projectName: String? = null,
    val mailboxes: List<MailMailboxChip> = emptyList(),
    val reauthorization: List<MailAccountNotice> = emptyList(),
    val facets: MailFacetsState = MailFacetsState(),
    val remoteSearch: MailRemoteSearchSummary? = null,
    val fromCache: Boolean = false,
    val actionFailed: Boolean = false,
    val actionRefusal: MailRefusal? = null,
)

sealed interface MailThreadsAction {
    data object Retry : MailThreadsAction
    data object Refresh : MailThreadsAction
    data object LoadMore : MailThreadsAction
    data class Search(val text: String) : MailThreadsAction
    data class SelectFilter(val filter: MailListFilter) : MailThreadsAction
    data class SelectMailbox(val mailboxId: String) : MailThreadsAction

    /** `null` is every project. */
    data class SetProject(val projectId: String?) : MailThreadsAction
    data object ClearContext : MailThreadsAction
    data class ToggleRead(val threadId: String) : MailThreadsAction
    data object DismissFailure : MailThreadsAction

    /** Asks the app to show [target]: a thread, the mailboxes, a new message or an account. */
    data class Open(val target: MailThreadsEffect) : MailThreadsAction
}

sealed interface MailThreadsEffect {
    data class OpenThread(val threadId: String) : MailThreadsEffect
    data object OpenFolders : MailThreadsEffect
    data object Compose : MailThreadsEffect
    data class OpenAccount(val mailboxId: String) : MailThreadsEffect
}
