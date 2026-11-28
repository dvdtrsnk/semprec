package cz.alldots.app.data

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
import cz.alldots.app.domain.map
import cz.alldots.app.domain.then
import io.ktor.http.HttpMethod
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull

private const val APPROVALS_PATH = "/api/approval-requests"
private const val PAGE_SIZE = 50

@Serializable
internal data class SempApprovalListDto(val rows: List<SempApprovalDto>, val nextCursor: String? = null)

@Serializable
internal data class SempApprovalCountDto(val count: Int)

/** One request: a row of the queue, or the answer of a decision, which carries the same fields. */
@Serializable
internal data class SempApprovalDto(
    val id: String,
    val toolName: String,
    val riskLevel: String,
    val requestedAt: String,
    val agentRunId: String,
    val projectName: String? = null,
    val safeSummary: SempSafeSummaryDto,
    val description: SempApprovalDescriptionDto? = null,
    val breaksLinks: List<JsonElement> = emptyList(),
    val source: SempApprovalSourceDto,
    val status: String = "pending",
    val executionStatus: String = "not_approved",
    val conflictReason: SempConflictDto? = null,
)

@Serializable
internal data class SempSafeSummaryDto(
    val kind: String,
    val argKeys: List<String> = emptyList(),
    val mcpServerName: String? = null,
    val mcpToolName: String? = null,
    val operationName: String? = null,
    val toolName: String? = null,
)

@Serializable
internal data class SempApprovalDescriptionDto(val key: String, val params: Map<String, JsonElement> = emptyMap())

@Serializable
internal data class SempApprovalSourceDto(
    val kind: String,
    val threadId: String? = null,
    val threadTitle: String? = null,
    val heartbeatName: String? = null,
)

@Serializable
internal data class SempDecisionBody(val decision: String)

/** The approval requests of the person: the queue, its count and the decision of one request. */
class HttpSempApprovalRepository(private val api: AuthenticatedApi) : SempApprovalRepository {

    override suspend fun list(pending: Boolean, cursor: String?): RepositoryResult<SempApprovalsPage> {
        val parameters = listOfNotNull(
            "status" to if (pending) "pending" else "decided",
            "limit" to PAGE_SIZE.toString(),
            cursor?.let { "cursor" to it },
        )
        return api.send(HttpMethod.Get, APPROVALS_PATH, query = parameters).decode<SempApprovalListDto>().map { page ->
            SempApprovalsPage(page.rows.mapNotNull { it.toDomain() }, page.nextCursor)
        }
    }

    override suspend fun pendingCount(): RepositoryResult<Int> =
        api.send(HttpMethod.Get, "$APPROVALS_PATH/count", query = listOf("status" to "pending"))
            .decode<SempApprovalCountDto>()
            .map { it.count }

    override suspend fun get(approvalId: String): RepositoryResult<SempApproval> =
        api.send(HttpMethod.Get, "$APPROVALS_PATH/$approvalId").decode<SempApprovalDto>().then { dto ->
            dto.toDomain()?.let { RepositoryResult.Content(it) }
                ?: RepositoryResult.Failure(FailureKind.INVALID_DATA)
        }

    override suspend fun decide(approvalId: String, approve: Boolean): RepositoryResult<SempApproval> {
        val body = ApiJson.encodeToString(SempDecisionBody(if (approve) "approved" else "rejected"))
        return api.send(HttpMethod.Patch, "$APPROVALS_PATH/$approvalId", body = body)
            .decode<SempApprovalDto>()
            .then { dto ->
                dto.toDomain()?.let { RepositoryResult.Content(it) }
                    ?: RepositoryResult.Failure(FailureKind.INVALID_DATA)
            }
    }
}

private fun SempApprovalDto.toDomain(): SempApproval? {
    val approvalRisk = riskOf(riskLevel)
    val approvalSource = sourceOf(source.kind)
    val approvalStatus = statusOf(status)
    if (approvalRisk == null || approvalSource == null || approvalStatus == null) return null
    return SempApproval(
        id = id,
        toolName = toolName,
        risk = approvalRisk,
        requestedAt = requestedAt,
        description = description?.let { SempApprovalDescription(it.key, it.params.toTextParams()) },
        call = safeSummary.toCall(),
        runId = agentRunId,
        projectName = projectName,
        source = approvalSource,
        threadId = source.threadId,
        threadTitle = source.threadTitle,
        heartbeatName = source.heartbeatName,
        breaksLink = breaksLinks.isNotEmpty(),
        status = approvalStatus,
        execution = executionOf(executionStatus),
        conflictKey = conflictReason?.key,
    )
}

private fun riskOf(wire: String): SempApprovalRisk? = when (wire) {
    "irreversible" -> SempApprovalRisk.IRREVERSIBLE
    "outbound" -> SempApprovalRisk.OUTBOUND
    "breaksLink" -> SempApprovalRisk.BREAKS_LINK
    "write" -> SempApprovalRisk.WRITE
    else -> null
}

private fun sourceOf(wire: String): SempApprovalSource? = when (wire) {
    "chat" -> SempApprovalSource.CHAT
    "tick" -> SempApprovalSource.TICK
    "mcp" -> SempApprovalSource.MCP
    else -> null
}

private fun statusOf(wire: String): SempApprovalStatus? = when (wire) {
    "pending" -> SempApprovalStatus.PENDING
    "approved" -> SempApprovalStatus.APPROVED
    "rejected" -> SempApprovalStatus.REJECTED
    else -> null
}

private fun executionOf(wire: String): SempApprovalExecution = when (wire) {
    "queued" -> SempApprovalExecution.QUEUED
    "succeeded" -> SempApprovalExecution.SUCCEEDED
    "conflict" -> SempApprovalExecution.CONFLICT
    else -> SempApprovalExecution.NOT_RUN
}

/** The parameters of a description are names and counts; each becomes its text, and a missing value stays out. */
private fun Map<String, JsonElement>.toTextParams(): Map<String, String> =
    mapNotNull { (name, value) -> (value as? JsonPrimitive)?.contentOrNull?.let { name to it } }.toMap()

private fun SempSafeSummaryDto.toCall(): SempApprovalCall = SempApprovalCall(
    label = when (kind) {
        "mcpInvoke" -> listOfNotNull(mcpServerName, mcpToolName).joinToString(" - ").ifEmpty { null }
        "genericOperation" -> operationName
        else -> toolName
    },
    argumentKeys = argKeys,
)
