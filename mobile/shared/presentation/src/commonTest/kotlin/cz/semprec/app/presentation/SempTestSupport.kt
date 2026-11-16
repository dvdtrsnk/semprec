package cz.semprec.app.presentation

import cz.semprec.app.core.FailureKind
import cz.semprec.app.domain.RepositoryResult
import cz.semprec.app.domain.SempApproval
import cz.semprec.app.domain.SempApprovalCall
import cz.semprec.app.domain.SempApprovalDescription
import cz.semprec.app.domain.SempApprovalExecution
import cz.semprec.app.domain.SempApprovalRepository
import cz.semprec.app.domain.SempApprovalRisk
import cz.semprec.app.domain.SempApprovalSource
import cz.semprec.app.domain.SempApprovalStatus
import cz.semprec.app.domain.SempApprovalsPage
import cz.semprec.app.domain.SempChange
import cz.semprec.app.domain.SempChangeKind
import cz.semprec.app.domain.SempContextRef
import cz.semprec.app.domain.SempDrift
import cz.semprec.app.domain.SempDriftChoice
import cz.semprec.app.domain.SempGuidance
import cz.semprec.app.domain.SempGuidanceDocument
import cz.semprec.app.domain.SempGuidanceSave
import cz.semprec.app.domain.SempMessage
import cz.semprec.app.domain.SempMessageStatus
import cz.semprec.app.domain.SempMessagesPage
import cz.semprec.app.domain.SempProjectAgentRepository
import cz.semprec.app.domain.SempProjectRun
import cz.semprec.app.domain.SempProjectTask
import cz.semprec.app.domain.SempRefInput
import cz.semprec.app.domain.SempRefKind
import cz.semprec.app.domain.SempRepository
import cz.semprec.app.domain.SempRole
import cz.semprec.app.domain.SempRun
import cz.semprec.app.domain.SempRunRepository
import cz.semprec.app.domain.SempRunStatus
import cz.semprec.app.domain.SempRunStep
import cz.semprec.app.domain.SempRunStepKind
import cz.semprec.app.domain.SempRunStepState
import cz.semprec.app.domain.SempRunStepsPage
import cz.semprec.app.domain.SempRunTrigger
import cz.semprec.app.domain.SempSendReceipt
import cz.semprec.app.domain.SempSendRequest
import cz.semprec.app.domain.SempStatusReport
import cz.semprec.app.domain.SempStatusRepository
import cz.semprec.app.domain.SempStatusSummary
import cz.semprec.app.domain.SempStep
import cz.semprec.app.domain.SempStepApproval
import cz.semprec.app.domain.SempStepStatus
import cz.semprec.app.domain.SempThread
import cz.semprec.app.domain.SempThreadKind
import cz.semprec.app.domain.SempThreadRow
import cz.semprec.app.domain.SempThreadsPage
import cz.semprec.app.domain.SempThreadsQuery
import cz.semprec.app.domain.SempTickHeader
import cz.semprec.app.domain.SempToolGrant
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
        RepositoryResult.Content("Semprec iOS")

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
