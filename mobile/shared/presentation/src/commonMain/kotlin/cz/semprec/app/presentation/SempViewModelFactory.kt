package cz.semprec.app.presentation

import cz.semprec.app.domain.CountSempApprovals
import cz.semprec.app.domain.DecideSempApproval
import cz.semprec.app.domain.EditSempProjectAgent
import cz.semprec.app.domain.GetSempApproval
import cz.semprec.app.domain.ListSempApprovals
import cz.semprec.app.domain.ListSempProjectRuns
import cz.semprec.app.domain.ListSempThreads
import cz.semprec.app.domain.LoadOlderSempMessages
import cz.semprec.app.domain.LoadSempConversation
import cz.semprec.app.domain.LoadSempProjectAgent
import cz.semprec.app.domain.LoadSempRun
import cz.semprec.app.domain.LoadSempRunSteps
import cz.semprec.app.domain.LoadSempStatus
import cz.semprec.app.domain.LoadSempStatusSummary
import cz.semprec.app.domain.RegenerateSempReply
import cz.semprec.app.domain.RetrySempReply
import cz.semprec.app.domain.RetrySempRun
import cz.semprec.app.domain.SempApprovalRepository
import cz.semprec.app.domain.SempProjectAgentRepository
import cz.semprec.app.domain.SempRepository
import cz.semprec.app.domain.SempRunRepository
import cz.semprec.app.domain.SempStatusRepository
import cz.semprec.app.domain.SendSempMessage
import kotlin.experimental.ExperimentalObjCRefinement
import kotlin.native.HiddenFromObjC

/**
 * Creates the Semp ViewModels, whose constructors are internal, for the SDK in the umbrella module. Hidden from
 * Objective-C and Swift so that the domain ports it takes stay out of the exported native API. [session] is what the
 * bubble and the chats of one window share.
 */
@OptIn(ExperimentalObjCRefinement::class)
@HiddenFromObjC
class SempViewModelFactory(
    private val chats: SempRepository,
    private val status: SempStatusRepository,
    private val runs: SempRunRepository,
    private val approvals: SempApprovalRepository,
    private val agent: SempProjectAgentRepository,
    private val session: SempSession,
) {
    private fun approvalFlow() = SempApprovalFlow(DecideSempApproval(approvals), GetSempApproval(approvals))

    /**
     * One new ViewModel per call; the caller owns it. [threadId] names the thread of [SempThreadStart.EXISTING],
     * [inboxItemId] the Inbox item of [SempThreadStart.ITEM]; [title] and [meta] are how the screen that opened the
     * thread named what it is about.
     */
    fun threadViewModel(
        start: SempThreadStart,
        threadId: String?,
        inboxItemId: String?,
        title: String?,
        meta: String?,
    ): SempThreadViewModel {
        val reader = SempThreadReader(
            LoadSempConversation(chats),
            ListSempThreads(chats),
            LoadSempStatusSummary(status),
            GetSempApproval(approvals),
        )
        val send =
            SempSendCases(
                SendSempMessage(chats),
                RetrySempReply(chats),
                RegenerateSempReply(chats),
                EditSempProjectAgent(agent),
            )
        val origin = SempThreadOrigin(
            start, threadId, inboxItemId,
            SempSubject(title, meta).takeIf {
                title != null || meta != null
            }
        )
        val services =
            SempThreadServices(reader, send, LoadOlderSempMessages(chats), LoadSempRunSteps(runs), approvalFlow())
        return SempThreadViewModel(origin, session, services)
    }

    fun chatsViewModel(): SempChatsViewModel = SempChatsViewModel(
        SempChatsReads(ListSempThreads(chats), ListSempApprovals(approvals), CountSempApprovals(approvals)),
        approvalFlow(),
    )

    fun statusViewModel(): SempStatusViewModel = SempStatusViewModel(
        LoadSempStatus(status),
        SempStatusFixes(RetrySempRun(runs), RetrySempReply(chats), EditSempProjectAgent(agent)),
    )

    fun runViewModel(runId: String, messageId: String?): SempRunViewModel =
        SempRunViewModel(runId, messageId, LoadSempRun(runs), LoadSempRunSteps(runs), RetrySempRun(runs))

    fun approvalsViewModel(): SempApprovalsViewModel =
        SempApprovalsViewModel(ListSempApprovals(approvals), CountSempApprovals(approvals), approvalFlow())

    fun projectAgentViewModel(projectId: String): SempProjectAgentViewModel = SempProjectAgentViewModel(
        projectId,
        SempProjectAgentCases(LoadSempProjectAgent(agent), EditSempProjectAgent(agent), ListSempProjectRuns(runs)),
    )

    fun bubbleViewModel(): SempBubbleViewModel =
        SempBubbleViewModel(session, CountSempApprovals(approvals), ListSempThreads(chats))
}
