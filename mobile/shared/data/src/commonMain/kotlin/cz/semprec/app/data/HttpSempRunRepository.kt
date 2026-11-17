package cz.semprec.app.data

import cz.semprec.app.core.FailureKind
import cz.semprec.app.domain.RepositoryResult
import cz.semprec.app.domain.SempProjectRun
import cz.semprec.app.domain.SempRun
import cz.semprec.app.domain.SempRunRepository
import cz.semprec.app.domain.SempRunStatus
import cz.semprec.app.domain.SempRunStep
import cz.semprec.app.domain.SempRunStepKind
import cz.semprec.app.domain.SempRunStepState
import cz.semprec.app.domain.SempRunStepsPage
import cz.semprec.app.domain.SempRunTrigger
import cz.semprec.app.domain.SempRunUsage
import cz.semprec.app.domain.map
import cz.semprec.app.domain.then
import io.ktor.http.HttpMethod
import kotlinx.serialization.Serializable

private const val RUNS_PATH = "/api/agent-runs"
private const val PROJECT_RUNS_LIMIT = 20

@Serializable
internal data class SempRunDto(
    val id: String,
    val title: String,
    val displayStatus: String,
    val projectName: String? = null,
    val startedAt: String,
    val durationMs: Long? = null,
    val trigger: SempRunTriggerDto,
    val approvals: SempRunApprovalsDto,
    val errorSummary: String? = null,
    val retriedByRunId: String? = null,
    val usage: SempRunUsageDto,
)

@Serializable
internal data class SempRunTriggerDto(val kind: String, val threadId: String? = null)

@Serializable
internal data class SempRunApprovalsDto(val count: Int = 0, val pending: Int = 0)

@Serializable
internal data class SempRunUsageDto(
    val totalCostUsd: Double = 0.0,
    val estimated: Boolean = false,
    val perModel: List<SempRunModelUsageDto> = emptyList(),
)

@Serializable
internal data class SempRunModelUsageDto(
    val displayName: String,
    val callCount: Int = 0,
    val inputTokens: Long = 0,
    val outputTokens: Long = 0,
    val costUsd: Double = 0.0,
)

@Serializable
internal data class SempRunStepsDto(
    val steps: List<SempRunStepDto>,
    val nextCursor: String? = null,
    val truncatedHistory: Boolean = false,
)

@Serializable
internal data class SempRunStepDto(
    val stepId: String,
    val kind: String,
    val state: String,
    val at: String,
    val durationMs: Long? = null,
    val title: String,
    val summary: String? = null,
    val targetName: String? = null,
    val approvalRequestId: String? = null,
)

@Serializable
internal data class SempProjectRunsDto(val rows: List<SempProjectRunDto>)

@Serializable
internal data class SempProjectRunDto(
    val id: String,
    val agentRunId: String,
    val messageId: String? = null,
    val title: String,
    val triggeredBy: String,
    val startedAt: String,
    val durationMs: Long? = null,
    val costUsd: Double = 0.0,
    val displayStatus: String,
    val errorSummary: String? = null,
)

/** The runs of the agent: `GET /api/agent-runs/:id` (and its steps), the project's list and the retry of a run. */
class HttpSempRunRepository(private val api: AuthenticatedApi) : SempRunRepository {

    override suspend fun run(runId: String, messageId: String?): RepositoryResult<SempRun> =
        api.send(HttpMethod.Get, "$RUNS_PATH/$runId", query = messageQuery(messageId))
            .decode<SempRunDto>()
            .then { dto -> dto.toDomain()?.let { RepositoryResult.Content(it) } ?: invalid() }

    override suspend fun steps(runId: String, messageId: String?, after: String?): RepositoryResult<SempRunStepsPage> {
        val parameters = messageQuery(messageId) + listOfNotNull(after?.let { "after" to it })
        return api.send(HttpMethod.Get, "$RUNS_PATH/$runId/steps", query = parameters)
            .decode<SempRunStepsDto>()
            .map { page ->
                SempRunStepsPage(page.steps.mapNotNull { it.toDomain() }, page.nextCursor, page.truncatedHistory)
            }
    }

    override suspend fun retry(runId: String): RepositoryResult<Unit> =
        api.send(HttpMethod.Post, "$RUNS_PATH/$runId/retry").ignoreBody()

    override suspend fun projectRuns(projectId: String): RepositoryResult<List<SempProjectRun>> =
        api.send(
            HttpMethod.Get,
            RUNS_PATH,
            query = listOf("projectItemId" to projectId, "limit" to PROJECT_RUNS_LIMIT.toString()),
        ).decode<SempProjectRunsDto>().map { list -> list.rows.mapNotNull { it.toDomain() } }

    private fun messageQuery(messageId: String?): List<Pair<String, String>> =
        listOfNotNull(messageId?.let { "messageId" to it })

    private fun <T> invalid(): RepositoryResult<T> = RepositoryResult.Failure(FailureKind.INVALID_DATA)
}

private fun runStatus(wire: String): SempRunStatus? = when (wire) {
    "running" -> SempRunStatus.RUNNING
    "done" -> SempRunStatus.DONE
    "waiting_approval" -> SempRunStatus.WAITING_APPROVAL
    "error" -> SempRunStatus.ERROR
    else -> null
}

private fun runTrigger(wire: String): SempRunTrigger? = when (wire) {
    "user" -> SempRunTrigger.USER
    "tick", "heartbeat" -> SempRunTrigger.TICK
    "mcp" -> SempRunTrigger.MCP
    "supervisor" -> SempRunTrigger.SUPERVISOR
    else -> null
}

private fun SempRunDto.toDomain(): SempRun? {
    val status = runStatus(displayStatus)
    val triggerKind = runTrigger(trigger.kind)
    if (status == null || triggerKind == null) return null
    return SempRun(
        id = id,
        title = title,
        status = status,
        trigger = triggerKind,
        threadId = trigger.threadId,
        projectName = projectName,
        startedAt = startedAt,
        durationMs = durationMs,
        approvalCount = approvals.count,
        pendingApprovalCount = approvals.pending,
        errorSummary = errorSummary,
        retriedByRunId = retriedByRunId,
        totalCostUsd = usage.totalCostUsd,
        costIsEstimate = usage.estimated,
        usage = usage.perModel.map {
            SempRunUsage(it.displayName, it.callCount, it.inputTokens, it.outputTokens, it.costUsd)
        },
    )
}

private fun stepKind(wire: String): SempRunStepKind? = when (wire) {
    "start" -> SempRunStepKind.START
    "plan" -> SempRunStepKind.PLAN
    "tool" -> SempRunStepKind.TOOL
    "approval" -> SempRunStepKind.APPROVAL
    "answer" -> SempRunStepKind.ANSWER
    "end" -> SempRunStepKind.END
    "error" -> SempRunStepKind.ERROR
    else -> null
}

private fun stepState(wire: String): SempRunStepState? = when (wire) {
    "running" -> SempRunStepState.RUNNING
    "ok" -> SempRunStepState.OK
    "error" -> SempRunStepState.ERROR
    "waitingApproval" -> SempRunStepState.WAITING_APPROVAL
    else -> null
}

private fun SempRunStepDto.toDomain(): SempRunStep? {
    val kindOfStep = stepKind(kind)
    val stateOfStep = stepState(state)
    if (kindOfStep == null || stateOfStep == null) return null
    return SempRunStep(stepId, kindOfStep, stateOfStep, at, durationMs, title, summary, targetName, approvalRequestId)
}

private fun SempProjectRunDto.toDomain(): SempProjectRun? {
    val status = runStatus(displayStatus)
    val triggerKind = runTrigger(triggeredBy)
    if (status == null || triggerKind == null) return null
    return SempProjectRun(
        id = id,
        runId = agentRunId,
        messageId = messageId,
        title = title,
        trigger = triggerKind,
        startedAt = startedAt,
        durationMs = durationMs,
        costUsd = costUsd,
        status = status,
        errorSummary = errorSummary,
    )
}
