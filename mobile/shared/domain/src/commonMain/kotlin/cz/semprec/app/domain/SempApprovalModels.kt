package cz.semprec.app.domain

/** Where an approval request came from. */
enum class SempApprovalSource { CHAT, TICK, MCP }

/** How much a request can hurt, as the server's closed key. */
enum class SempApprovalRisk { IRREVERSIBLE, OUTBOUND, BREAKS_LINK, WRITE }

enum class SempApprovalStatus { PENDING, APPROVED, REJECTED }

/** What came of an approved request. [NOT_RUN] is a request not approved (yet). */
enum class SempApprovalExecution { NOT_RUN, QUEUED, SUCCEEDED, CONFLICT }

/** What the server snapshotted about a request: a template key and its parameters, never rendered text. */
data class SempApprovalDescription(val key: String, val params: Map<String, String>)

/** What the request calls: a generic operation, an MCP tool or a module tool, with only the names of its arguments. */
data class SempApprovalCall(val label: String?, val argumentKeys: List<String>)

data class SempApproval(
    val id: String,
    val toolName: String,
    val risk: SempApprovalRisk,
    val requestedAt: String,
    val description: SempApprovalDescription?,
    val call: SempApprovalCall,
    val runId: String,
    val projectName: String?,
    val source: SempApprovalSource,
    val threadId: String?,
    val threadTitle: String?,
    val heartbeatName: String?,
    val breaksLink: Boolean,
    val status: SempApprovalStatus,
    val execution: SempApprovalExecution,
    val conflictKey: String?,
)

data class SempApprovalsPage(val rows: List<SempApproval>, val nextCursor: String?)

interface SempApprovalRepository {
    /** The requests that wait ([pending] `true`) or that were decided, newest first. */
    suspend fun list(pending: Boolean, cursor: String?): RepositoryResult<SempApprovalsPage>

    suspend fun pendingCount(): RepositoryResult<Int>

    /** One request in any status, as it stands now. */
    suspend fun get(approvalId: String): RepositoryResult<SempApproval>

    /** Approves or rejects [approvalId]; the answer is the request as it stands after the decision. */
    suspend fun decide(approvalId: String, approve: Boolean): RepositoryResult<SempApproval>
}
