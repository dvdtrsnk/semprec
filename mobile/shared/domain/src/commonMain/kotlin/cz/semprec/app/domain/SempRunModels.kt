package cz.semprec.app.domain

/** What a client shows as the state of a run. [WAITING_APPROVAL] is a finished run with a request waiting. */
enum class SempRunStatus { RUNNING, DONE, WAITING_APPROVAL, ERROR }

/** What started a run. */
enum class SempRunTrigger { USER, TICK, MCP, SUPERVISOR }

/** The AI spend of a run in one model. */
data class SempRunUsage(
    val modelName: String,
    val calls: Int,
    val inputTokens: Long,
    val outputTokens: Long,
    val costUsd: Double,
)

/** One run of the agent. [durationMs] is `null` while it runs and for runs whose two instants do not bound the work. */
data class SempRun(
    val id: String,
    val title: String,
    val status: SempRunStatus,
    val trigger: SempRunTrigger,
    val threadId: String?,
    val projectName: String?,
    val startedAt: String,
    val durationMs: Long?,
    val approvalCount: Int,
    val pendingApprovalCount: Int,
    val errorSummary: String?,
    val retriedByRunId: String?,
    val totalCostUsd: Double,
    val costIsEstimate: Boolean,
    val usage: List<SempRunUsage>,
)

enum class SempRunStepKind { START, PLAN, TOOL, APPROVAL, ANSWER, END, ERROR }

enum class SempRunStepState { RUNNING, OK, ERROR, WAITING_APPROVAL }

/** One step of a run; [title] and [summary] are the server's, in the person's language. */
data class SempRunStep(
    val id: String,
    val kind: SempRunStepKind,
    val state: SempRunStepState,
    val at: String,
    val durationMs: Long?,
    val title: String,
    val summary: String?,
    val targetName: String?,
    val approvalRequestId: String?,
)

data class SempRunStepsPage(val steps: List<SempRunStep>, val nextCursor: String?, val truncatedHistory: Boolean)

/** One row of the runs a project's agent made: a run, an occurrence of an automatic task, or an answer of a chat. */
data class SempProjectRun(
    val id: String,
    val runId: String,
    val messageId: String?,
    val title: String,
    val trigger: SempRunTrigger,
    val startedAt: String,
    val durationMs: Long?,
    val costUsd: Double,
    val status: SempRunStatus,
    val errorSummary: String?,
)

interface SempRunRepository {
    /** The run [runId]; with [messageId] it describes that one answer of a chat run. */
    suspend fun run(runId: String, messageId: String?): RepositoryResult<SempRun>

    /** The steps after the cursor [after] (`null` for the first page). */
    suspend fun steps(runId: String, messageId: String?, after: String?): RepositoryResult<SempRunStepsPage>

    /** Queues a retry of a failed run of an automatic task. */
    suspend fun retry(runId: String): RepositoryResult<Unit>

    /** The most recent runs of a project's agent. */
    suspend fun projectRuns(projectId: String): RepositoryResult<List<SempProjectRun>>
}
