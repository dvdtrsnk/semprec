package cz.semprec.app.sdk

import cz.semprec.app.data.AuthenticatedApi
import cz.semprec.app.data.HttpSempApprovalRepository
import cz.semprec.app.data.HttpSempProjectAgentRepository
import cz.semprec.app.data.HttpSempRepository
import cz.semprec.app.data.HttpSempRunRepository
import cz.semprec.app.data.HttpSempStatusRepository
import cz.semprec.app.presentation.SempApprovalsViewModel
import cz.semprec.app.presentation.SempBubbleViewModel
import cz.semprec.app.presentation.SempChatsViewModel
import cz.semprec.app.presentation.SempProjectAgentViewModel
import cz.semprec.app.presentation.SempRunViewModel
import cz.semprec.app.presentation.SempSession
import cz.semprec.app.presentation.SempStatusViewModel
import cz.semprec.app.presentation.SempThreadStart
import cz.semprec.app.presentation.SempThreadViewModel
import cz.semprec.app.presentation.SempViewModelFactory

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
