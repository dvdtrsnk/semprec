package cz.semprec.app.presentation

import cz.semprec.app.core.FailureKind

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

/** An area or a project of the filter sheet with the number of threads it holds; [areaId] is a project's area. */
data class MailFilterOption(
    val id: String,
    val name: String,
    val color: String?,
    val count: Int,
    val areaId: String?,
)

enum class MailFacetsPhase { IDLE, LOADING, READY, ERROR }

/** The filter sheet: the areas and projects with their thread counts, loaded when the list starts and on every change. */
data class MailFacetsState(
    val phase: MailFacetsPhase = MailFacetsPhase.IDLE,
    val areaTotal: Int = 0,
    val projectTotal: Int = 0,
    val areas: List<MailFilterOption> = emptyList(),
    val projects: List<MailFilterOption> = emptyList(),
)

/**
 * The thread list. [search] is what the server was asked for, [areaName] and [projectName] name the chosen context.
 * A failed first load is [MailThreadsPhase.ERROR]; a failed refresh or "more" keeps the list and raises
 * [actionFailed]. [hasMore] says another page follows; [loadingMore] is `true` while it is fetched.
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
    val areaId: String? = null,
    val projectId: String? = null,
    val areaName: String? = null,
    val projectName: String? = null,
    val mailboxes: List<MailMailboxChip> = emptyList(),
    val reauthorization: List<MailAccountNotice> = emptyList(),
    val facets: MailFacetsState = MailFacetsState(),
    val actionFailed: Boolean = false,
)

sealed interface MailThreadsAction {
    data object Retry : MailThreadsAction
    data object Refresh : MailThreadsAction
    data object LoadMore : MailThreadsAction
    data class Search(val text: String) : MailThreadsAction
    data class SelectFilter(val filter: MailListFilter) : MailThreadsAction
    data class SelectMailbox(val mailboxId: String) : MailThreadsAction

    /** `null` is every area. Choosing an area other than the chosen project's drops the project. */
    data class SetArea(val areaId: String?) : MailThreadsAction

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
