package cz.alldots.app.presentation

import cz.alldots.app.core.FailureKind

enum class MailFoldersPhase { LOADING, CONTENT, ERROR }

/** What a mailbox is doing: in order, still downloading, failing, or waiting for the person to sign in again. */
enum class MailAccountStatus { OK, SYNCING, ERROR, NEEDS_REAUTHORIZATION }

/** A folder or label with its unread thread count; [specialPurpose] is the stored key (`inbox`, `sent`, `none`). */
data class MailFolderItem(
    val id: String,
    val name: String,
    val specialPurpose: String,
    val unreadCount: Int,
)

/** A mailbox with its folders. [foldersFailed] says its folders could not be read, the rest of the screen is intact. */
data class MailFolderAccount(
    val id: String,
    val name: String,
    val address: String?,
    val status: MailAccountStatus,
    val folders: List<MailFolderItem>,
    val foldersFailed: Boolean,
    val collapsed: Boolean,
)

/** The mailboxes screen: the smart boxes with their counts and every account with its folders. */
data class MailFoldersState(
    val phase: MailFoldersPhase = MailFoldersPhase.LOADING,
    val failure: FailureKind? = null,
    val refreshing: Boolean = false,
    val unreadInbox: Int = 0,
    val flagged: Int = 0,
    val sempDrafts: Int = 0,
    val accounts: List<MailFolderAccount> = emptyList(),
)

sealed interface MailFoldersAction {
    data object Retry : MailFoldersAction
    data object Refresh : MailFoldersAction
    data class ToggleAccount(val mailboxId: String) : MailFoldersAction
    data class OpenBox(val box: MailListBox) : MailFoldersAction
    data class OpenFolder(val mailboxId: String, val folderId: String) : MailFoldersAction
    data object Compose : MailFoldersAction
    data object OpenAccounts : MailFoldersAction
}

sealed interface MailFoldersEffect {
    /** The thread list of [start]; [title] is the name of the folder when the list is one. */
    data class OpenList(val start: MailListStart, val title: String?) : MailFoldersEffect
    data object Compose : MailFoldersEffect
    data object OpenAccounts : MailFoldersEffect
}
