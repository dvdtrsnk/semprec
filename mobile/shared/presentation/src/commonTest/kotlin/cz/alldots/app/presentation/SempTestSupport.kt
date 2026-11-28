package cz.alldots.app.presentation

import cz.alldots.app.core.FailureKind
import cz.alldots.app.domain.RepositoryResult
import cz.alldots.app.domain.SempApproval
import cz.alldots.app.domain.SempApprovalCall
import cz.alldots.app.domain.SempApprovalDescription
import cz.alldots.app.domain.SempApprovalExecution
import cz.alldots.app.domain.SempApprovalRepository
import cz.alldots.app.domain.SempApprovalRisk
import cz.alldots.app.domain.SempApprovalSource
import cz.alldots.app.domain.SempApprovalStatus
import cz.alldots.app.domain.SempApprovalsPage
import cz.alldots.app.domain.SempChange
import cz.alldots.app.domain.SempChangeKind
import cz.alldots.app.domain.SempContextRef
import cz.alldots.app.domain.SempDrift
import cz.alldots.app.domain.SempDriftChoice
import cz.alldots.app.domain.SempGuidance
import cz.alldots.app.domain.SempGuidanceDocument
import cz.alldots.app.domain.SempGuidanceSave
import cz.alldots.app.domain.SempMessage
import cz.alldots.app.domain.SempMessageStatus
import cz.alldots.app.domain.SempMessagesPage
import cz.alldots.app.domain.SempProjectAgentRepository
import cz.alldots.app.domain.SempProjectRun
import cz.alldots.app.domain.SempProjectTask
import cz.alldots.app.domain.SempRefInput
import cz.alldots.app.domain.SempRefKind
import cz.alldots.app.domain.SempRepository
import cz.alldots.app.domain.SempRole
import cz.alldots.app.domain.SempRun
import cz.alldots.app.domain.SempRunRepository
import cz.alldots.app.domain.SempRunStatus
import cz.alldots.app.domain.SempRunStep
import cz.alldots.app.domain.SempRunStepKind
import cz.alldots.app.domain.SempRunStepState
import cz.alldots.app.domain.SempRunStepsPage
import cz.alldots.app.domain.SempRunTrigger
import cz.alldots.app.domain.SempSendReceipt
import cz.alldots.app.domain.SempSendRequest
import cz.alldots.app.domain.SempStatusReport
import cz.alldots.app.domain.SempStatusRepository
import cz.alldots.app.domain.SempStatusSummary
import cz.alldots.app.domain.SempStep
import cz.alldots.app.domain.SempStepApproval
import cz.alldots.app.domain.SempStepStatus
import cz.alldots.app.domain.SempThread
import cz.alldots.app.domain.SempThreadKind
import cz.alldots.app.domain.SempThreadRow
import cz.alldots.app.domain.SempThreadsPage
import cz.alldots.app.domain.SempThreadsQuery
import cz.alldots.app.domain.SempTickHeader
import cz.alldots.app.domain.SempToolGrant
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.withContext

fun sempContent(): RepositoryResult.Content<Unit> = RepositoryResult.Content(Unit)

fun <T> sempFailure(kind: FailureKind = FailureKind.UNAVAILABLE): RepositoryResult<T> = RepositoryResult.Failure(kind)

fun sempThread(
    id: String = "t1",
    kind: SempThreadKind = SempThreadKind.CHAT,
    tick: SempTickHeader? = null,
    activeRunId: String? = null,
) = SempThread(id, kind, null, null, tick, activeRunId)

fun sempUser(id: String, text: String, at: String, context: List<SempContextRef> = emptyList()) = SempMessage(
    id = id,
    role = SempRole.USER,
    text = text,
    systemKey = null,
    context = context,
    replyToMessageId = null,
    attempt = 1,
    replaced = false,
    agentRunId = null,
    status = SempMessageStatus.DONE,
    createdAt = at,
    changes = emptyList(),
    steps = emptyList(),
    incomplete = false,
    error = null,
)

fun sempReply(
    id: String,
    replyTo: String,
    at: String,
    status: SempMessageStatus = SempMessageStatus.DONE,
    text: String? = "Done.",
    attempt: Int = 1,
    replaced: Boolean = false,
    runId: String? = null,
    steps: List<SempStep> = emptyList(),
    changes: List<SempChange> = emptyList(),
    incomplete: Boolean = false,
) = SempMessage(
    id = id,
    role = SempRole.ASSISTANT,
    text = text,
    systemKey = null,
    context = emptyList(),
    replyToMessageId = replyTo,
    attempt = attempt,
    replaced = replaced,
    agentRunId = runId,
    status = status,
    createdAt = at,
    changes = changes,
    steps = steps,
    incomplete = incomplete,
    error = null,
)

fun sempStep(
    status: SempStepStatus = SempStepStatus.OK,
    durationMs: Long = 400,
    approvalId: String? = null,
    approval: SempStepApproval? = null,
) = SempStep(status, durationMs, approvalId, approval)

fun sempChange(label: String? = "Send invoice") =
    SempChange("i1", "d1", SempChangeKind.UPDATED, label, "tasks", active = true)

fun sempChip(label: String = "Send invoice") = SempContextRef(SempRefKind.ITEM, "i1", "d1", "tasks", label, true)

fun sempConversationPage(vararg messages: SempMessage, next: String? = null) =
    RepositoryResult.Content(SempMessagesPage(messages.toList(), next))

fun sempApproval(
    id: String = "ap1",
    status: SempApprovalStatus = SempApprovalStatus.PENDING,
    execution: SempApprovalExecution = SempApprovalExecution.NOT_RUN,
) = SempApproval(
    id = id,
    toolName = "item.delete",
    risk = SempApprovalRisk.IRREVERSIBLE,
    requestedAt = "2026-10-21T13:24:00.000Z",
    description = SempApprovalDescription("approval.itemDelete", mapOf("itemName" to "Tax return")),
    call = SempApprovalCall("item.delete", listOf("itemId")),
    runId = "r1",
    projectName = "Finance",
    source = SempApprovalSource.CHAT,
    threadId = "t1",
    threadTitle = "Plan",
    heartbeatName = null,
    breaksLink = false,
    status = status,
    execution = execution,
    conflictKey = null,
)

/**
 * A scripted chat repository. Each [messages] call takes the next answer of [messageAnswers], then repeats the last
 * one; [send] takes the next of [sendAnswers] the same way. Calls are recorded. While [sendGate] is set, a send waits
 * for it.
 */
class FakeSempRepository(
    var threadsAnswer: RepositoryResult<SempThreadsPage> = RepositoryResult.Content(SempThreadsPage(emptyList(), null)),
    val threadAnswers: MutableMap<String, RepositoryResult<SempThread>> = mutableMapOf(),
    val messageAnswers: MutableList<RepositoryResult<SempMessagesPage>> = mutableListOf(),
    val sendAnswers: MutableList<RepositoryResult<SempSendReceipt>> = mutableListOf(),
) : SempRepository {
    val threadQueries = mutableListOf<SempThreadsQuery>()
    val messageCalls = mutableListOf<Pair<String, String?>>()
    val sent = mutableListOf<SempSendRequest>()
    val retries = mutableListOf<Pair<String, String>>()
    val regenerations = mutableListOf<Pair<String, String>>()
    var retryAnswer: RepositoryResult<Unit> = sempContent()
    var sendGate: CompletableDeferred<Unit>? = null

    /** While set, a thread read waits for it even after the caller was cancelled, like a late data layer. */
    var threadGate: CompletableDeferred<Unit>? = null
    private var messageIndex = 0
    private var sendIndex = 0

    override suspend fun threads(query: SempThreadsQuery): RepositoryResult<SempThreadsPage> {
        threadQueries += query
        return threadsAnswer
    }

    override suspend fun thread(threadId: String): RepositoryResult<SempThread> {
        threadGate?.let { gate -> withContext(NonCancellable) { gate.await() } }
        return threadAnswers[threadId] ?: RepositoryResult.Content(sempThread(threadId))
    }

    override suspend fun messages(threadId: String, before: String?): RepositoryResult<SempMessagesPage> {
        messageCalls += threadId to before
        val answer = messageAnswers[minOf(messageIndex, messageAnswers.lastIndex)]
        messageIndex += 1
        return answer
    }

    override suspend fun send(request: SempSendRequest): RepositoryResult<SempSendReceipt> {
        sent += request
        sendGate?.await()
        val answer = sendAnswers[minOf(sendIndex, sendAnswers.lastIndex)]
        sendIndex += 1
        return answer
    }

    override suspend fun retry(threadId: String, messageId: String): RepositoryResult<Unit> {
        retries += threadId to messageId
        return retryAnswer
    }

    override suspend fun regenerate(threadId: String, messageId: String): RepositoryResult<Unit> {
        regenerations += threadId to messageId
        return retryAnswer
    }
}

fun sempReceipt(threadId: String = "t1") = RepositoryResult.Content(SempSendReceipt(threadId, "m1", "m2"))

class FakeSempStatusRepository(
    var reportAnswer: RepositoryResult<SempStatusReport> =
        RepositoryResult.Content(SempStatusReport(0, emptyList(), emptyList(), emptyList())),
    var summaryAnswer: RepositoryResult<SempStatusSummary> =
        RepositoryResult.Content(SempStatusSummary(0, null, null, null)),
) : SempStatusRepository {
    var reportCalls = 0

    override suspend fun report(): RepositoryResult<SempStatusReport> {
        reportCalls += 1
        return reportAnswer
    }

    override suspend fun summary(): RepositoryResult<SempStatusSummary> = summaryAnswer
}

class FakeSempRunRepository(
    var runAnswer: RepositoryResult<SempRun> = RepositoryResult.Content(sempRun()),
    var stepsAnswer: RepositoryResult<SempRunStepsPage> =
        RepositoryResult.Content(SempRunStepsPage(emptyList(), null, false)),
    var projectRunsAnswer: RepositoryResult<List<SempProjectRun>> = RepositoryResult.Content(emptyList()),
) : SempRunRepository {
    val runAnswers = mutableListOf<RepositoryResult<SempRun>>()
    val stepCalls = mutableListOf<Triple<String, String?, String?>>()
    val retried = mutableListOf<String>()
    var retryAnswer: RepositoryResult<Unit> = sempContent()
    var runCalls = 0

    override suspend fun run(runId: String, messageId: String?): RepositoryResult<SempRun> {
        val answer = runAnswers.getOrNull(runCalls) ?: runAnswers.lastOrNull() ?: runAnswer
        runCalls += 1
        return answer
    }

    override suspend fun steps(runId: String, messageId: String?, after: String?): RepositoryResult<SempRunStepsPage> {
        stepCalls += Triple(runId, messageId, after)
        return stepsAnswer
    }

    override suspend fun retry(runId: String): RepositoryResult<Unit> {
        retried += runId
        return retryAnswer
    }

    override suspend fun projectRuns(projectId: String): RepositoryResult<List<SempProjectRun>> = projectRunsAnswer
}

fun sempRun(status: SempRunStatus = SempRunStatus.DONE, trigger: SempRunTrigger = SempRunTrigger.USER) = SempRun(
    id = "r1",
    title = "Move the invoice",
    status = status,
    trigger = trigger,
    threadId = "t1",
    projectName = "Semp",
    startedAt = "2026-10-21T13:24:02.000Z",
    durationMs = 4_100,
    approvalCount = 0,
    pendingApprovalCount = 0,
    errorSummary = null,
    retriedByRunId = null,
    totalCostUsd = 0.021,
    costIsEstimate = false,
    usage = emptyList(),
)

fun sempRunStep(id: String, title: String = "Step $id") =
    SempRunStep(id, SempRunStepKind.TOOL, SempRunStepState.OK, "t", 300, title, "summary", null, null)

class FakeSempApprovalRepository : SempApprovalRepository {
    var pending = mutableListOf(sempApproval())
    var decided = mutableListOf<SempApproval>()
    var listAnswer: RepositoryResult<SempApprovalsPage>? = null
    var decideAnswer: RepositoryResult<SempApproval> =
        RepositoryResult.Content(
            sempApproval(status = SempApprovalStatus.APPROVED, execution = SempApprovalExecution.QUEUED),
        )
    val getAnswers = mutableListOf<RepositoryResult<SempApproval>>()
    var getCalls = 0
    val decisions = mutableListOf<Pair<String, Boolean>>()
    val listCalls = mutableListOf<Pair<Boolean, String?>>()

    override suspend fun list(pending: Boolean, cursor: String?): RepositoryResult<SempApprovalsPage> {
        listCalls += pending to cursor
        return listAnswer ?: RepositoryResult.Content(SempApprovalsPage(if (pending) this.pending else decided, null))
    }

    override suspend fun pendingCount(): RepositoryResult<Int> = RepositoryResult.Content(pending.size)

    override suspend fun get(approvalId: String): RepositoryResult<SempApproval> {
        val answer = getAnswers.getOrNull(getCalls) ?: getAnswers.lastOrNull()
            ?: RepositoryResult.Content(pending.first { it.id == approvalId })
        getCalls += 1
        return answer
    }

    override suspend fun decide(approvalId: String, approve: Boolean): RepositoryResult<SempApproval> {
        decisions += approvalId to approve
        return decideAnswer
    }
}

class FakeSempProjectAgentRepository : SempProjectAgentRepository {
    var guidanceAnswer: RepositoryResult<SempGuidanceDocument> =
        RepositoryResult.Content(SempGuidanceDocument(SempGuidance("Help", "- read", "", "Czech"), "v1"))
    var saveAnswer: RepositoryResult<SempGuidanceSave>? = null
    var driftAnswer: RepositoryResult<SempDrift> = RepositoryResult.Content(SempDrift("v1", emptyList()))
    var resolveAnswer: RepositoryResult<SempGuidanceSave>? = null
    var grantsAnswer: RepositoryResult<List<SempToolGrant>> = RepositoryResult.Content(emptyList())
    var tasksAnswer: RepositoryResult<List<SempProjectTask>> = RepositoryResult.Content(emptyList())
    var writeAnswer: RepositoryResult<Unit> = sempContent()
    val saves = mutableListOf<Pair<SempGuidance, String?>>()
    val resolutions = mutableListOf<Triple<String, SempDriftChoice, String?>>()
    val grantWrites = mutableListOf<Triple<String, String, Boolean>>()
    val taskWrites = mutableListOf<Pair<String, Boolean>>()
    val ran = mutableListOf<String>()

    override suspend fun projectName(projectId: String): RepositoryResult<String?> =
        RepositoryResult.Content("Alldots iOS")

    override suspend fun guidance(projectId: String) = guidanceAnswer

    override suspend fun saveGuidance(
        projectId: String,
        guidance: SempGuidance,
        expectedUpdatedAt: String?,
    ): RepositoryResult<SempGuidanceSave> {
        saves += guidance to expectedUpdatedAt
        return saveAnswer ?: RepositoryResult.Content(
            SempGuidanceSave.Saved(SempGuidanceDocument(guidance, "v${saves.size + 1}")),
        )
    }

    override suspend fun drift(projectId: String) = driftAnswer

    override suspend fun resolveDrift(
        projectId: String,
        findingId: String,
        choice: SempDriftChoice,
        expectedGuidanceUpdatedAt: String?,
    ): RepositoryResult<SempGuidanceSave> {
        resolutions += Triple(findingId, choice, expectedGuidanceUpdatedAt)
        return resolveAnswer ?: RepositoryResult.Content(
            SempGuidanceSave.Saved(SempGuidanceDocument(SempGuidance("Help", "- read\n- tasks", "", "Czech"), "v9")),
        )
    }

    override suspend fun grants(projectId: String) = grantsAnswer

    override suspend fun setGrant(projectId: String, registrationId: String, granted: Boolean): RepositoryResult<Unit> {
        grantWrites += Triple(projectId, registrationId, granted)
        return writeAnswer
    }

    override suspend fun tasks(projectId: String) = tasksAnswer

    override suspend fun setTaskEnabled(taskId: String, enabled: Boolean): RepositoryResult<Unit> {
        taskWrites += taskId to enabled
        return writeAnswer
    }

    override suspend fun runTask(taskId: String): RepositoryResult<Unit> {
        ran += taskId
        return writeAnswer
    }
}

fun sempThreadRow(id: String, kind: SempThreadKind = SempThreadKind.CHAT, title: String? = "Plan") = SempThreadRow(
    id = id,
    kind = kind,
    title = title,
    preview = null,
    lastActivityAt = "2026-10-21T13:21:00.000Z",
    hasPendingApproval = false,
    projectName = null,
    subjectInboxItemId = null,
)

fun sempRefItem(id: String = "i1") = SempRefInput(SempRefKind.ITEM, id, "d1")

fun sempFactory(
    chats: FakeSempRepository = FakeSempRepository(),
    status: FakeSempStatusRepository = FakeSempStatusRepository(),
    runs: FakeSempRunRepository = FakeSempRunRepository(),
    approvals: FakeSempApprovalRepository = FakeSempApprovalRepository(),
    agent: FakeSempProjectAgentRepository = FakeSempProjectAgentRepository(),
    session: SempSession = SempSession(),
) = SempViewModelFactory(chats, status, runs, approvals, agent, session)
