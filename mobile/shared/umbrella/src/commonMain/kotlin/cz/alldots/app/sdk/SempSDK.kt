package cz.alldots.app.sdk

import cz.alldots.app.data.AuthenticatedApi
import cz.alldots.app.data.HttpSempApprovalRepository
import cz.alldots.app.data.HttpSempProjectAgentRepository
import cz.alldots.app.data.HttpSempRepository
import cz.alldots.app.data.HttpSempRunRepository
import cz.alldots.app.data.HttpSempStatusRepository
import cz.alldots.app.presentation.SempApprovalsViewModel
import cz.alldots.app.presentation.SempBubbleViewModel
import cz.alldots.app.presentation.SempChatsViewModel
import cz.alldots.app.presentation.SempProjectAgentViewModel
import cz.alldots.app.presentation.SempRunViewModel
import cz.alldots.app.presentation.SempSession
import cz.alldots.app.presentation.SempStatusViewModel
import cz.alldots.app.presentation.SempThreadStart
import cz.alldots.app.presentation.SempThreadViewModel
import cz.alldots.app.presentation.SempViewModelFactory

/**
 * The Semp part of [HomeSDK]: the chat, its history, the status of Semp, the runs of the agent, the approval requests,
 * the agent of a project and the bubble. Its session (what is staged on the bubble, which notices were closed) lives
 * as long as the SDK, that is, as long as the window. Every call creates a new ViewModel that the caller owns.
 */
class SempSDK internal constructor(api: AuthenticatedApi) {
    private val viewModels = SempViewModelFactory(
        HttpSempRepository(api),
        HttpSempStatusRepository(api),
        HttpSempRunRepository(api),
        HttpSempApprovalRepository(api),
        HttpSempProjectAgentRepository(api),
        SempSession(),
    )

    /**
     * A conversation. [threadId] names the thread of [SempThreadStart.EXISTING]; [inboxItemId] the Inbox item of
     * [SempThreadStart.ITEM]; [title] and [meta] name what the thread is about, as the screen that opened it knows.
     */
    fun threadViewModel(
        start: SempThreadStart,
        threadId: String?,
        inboxItemId: String?,
        title: String?,
        meta: String?,
    ): SempThreadViewModel = viewModels.threadViewModel(start, threadId, inboxItemId, title, meta)

    fun chatsViewModel(): SempChatsViewModel = viewModels.chatsViewModel()

    fun statusViewModel(): SempStatusViewModel = viewModels.statusViewModel()

    /** The run [runId]; [messageId] narrows it to one answer of a chat run. */
    fun runViewModel(runId: String, messageId: String?): SempRunViewModel = viewModels.runViewModel(runId, messageId)

    fun approvalsViewModel(): SempApprovalsViewModel = viewModels.approvalsViewModel()

    fun projectAgentViewModel(projectId: String): SempProjectAgentViewModel =
        viewModels.projectAgentViewModel(projectId)

    fun bubbleViewModel(): SempBubbleViewModel = viewModels.bubbleViewModel()
}
