package cz.alldots.app.data

import cz.alldots.app.domain.RepositoryResult
import cz.alldots.app.domain.SempDrift
import cz.alldots.app.domain.SempDriftChoice
import cz.alldots.app.domain.SempDriftFinding
import cz.alldots.app.domain.SempDriftKind
import cz.alldots.app.domain.SempGuidance
import cz.alldots.app.domain.SempGuidanceDocument
import cz.alldots.app.domain.SempGuidanceSave
import cz.alldots.app.domain.SempProjectAgentRepository
import cz.alldots.app.domain.SempProjectTask
import cz.alldots.app.domain.SempToolGrant
import cz.alldots.app.domain.map
import io.ktor.http.HttpMethod
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.encodeToJsonElement
import kotlinx.serialization.json.put

private const val CONFLICT_STATUS = 409

@Serializable
internal data class SempNamedItemDto(val properties: JsonObject = JsonObject(emptyMap()))

@Serializable
internal data class SempGuidanceSectionsDto(
    val purpose: String,
    val allowed: String,
    val notAllowed: String,
    val generalInstructions: String,
)

@Serializable
internal data class SempGuidanceDto(val sections: SempGuidanceSectionsDto, val updatedAt: String? = null)

@Serializable
internal data class SempDriftDto(val guidanceUpdatedAt: String? = null, val findings: List<SempDriftFindingDto>)

@Serializable
internal data class SempDriftFindingDto(
    val id: String,
    val kind: String,
    val claim: String,
    val severity: String,
    val suggestedAllowedLine: String? = null,
    val suggestedNotAllowedLine: String? = null,
)

@Serializable
internal data class SempDriftResolveDto(val guidance: SempGuidanceDto)

@Serializable
internal data class SempGrantListDto(val rows: List<SempGrantDto>)

@Serializable
internal data class SempGrantDto(
    val mcpToolRegistrationId: String,
    val toolName: String,
    val displayLabel: String? = null,
    val requiresApproval: Boolean = false,
    val mcpServerItemId: String,
    val mcpServerName: String,
    val mcpServerOnline: Boolean = false,
    val granted: Boolean = false,
)

@Serializable
internal data class SempGrantBody(val granted: Boolean)

@Serializable
internal data class SempTaskListDto(val rows: List<SempTaskDto>)

@Serializable
internal data class SempTaskDto(
    val id: String,
    val name: String,
    val ruleLabel: String = "",
    val enabled: Boolean = false,
    val threadId: String? = null,
    val lastOccurrence: SempLastOccurrenceDto? = null,
)

@Serializable
internal data class SempLastOccurrenceDto(val at: String, val status: String, val errorSummary: String? = null)

@Serializable
internal data class SempEnabledBody(val enabled: Boolean)

/**
 * A project's agent over the backend: its guidance (`AGENT.md`) and the drift findings against it, the tools it may
 * use, and its automatic tasks. A write that conflicts with a newer guidance is answered with that newer guidance,
 * which the server does not send in a body this client keeps, so it is read again.
 */
class HttpSempProjectAgentRepository(private val api: AuthenticatedApi) : SempProjectAgentRepository {

    override suspend fun projectName(projectId: String): RepositoryResult<String?> =
        api.send(HttpMethod.Get, "/api/items/$projectId").decode<SempNamedItemDto>().map {
            (it.properties["name"] as? JsonPrimitive)?.contentOrNull
        }

    override suspend fun guidance(projectId: String): RepositoryResult<SempGuidanceDocument> =
        api.send(HttpMethod.Get, "/api/projects/$projectId/agent-guidance").decode<SempGuidanceDto>()
            .map { it.toDomain() }

    override suspend fun saveGuidance(
        projectId: String,
        guidance: SempGuidance,
        expectedUpdatedAt: String?,
    ): RepositoryResult<SempGuidanceSave> {
        val body = buildJsonObject {
            put("sections", ApiJson.encodeToJsonElement(guidance.toDto()))
            put("expectedUpdatedAt", expectedUpdatedAt)
        }.toString()
        val response = api.send(HttpMethod.Put, "/api/projects/$projectId/agent-guidance", body = body)
        return savedOrConflict(projectId, response)
    }

    override suspend fun drift(projectId: String): RepositoryResult<SempDrift> =
        api.send(HttpMethod.Get, "/api/projects/$projectId/agent-guidance/drift").decode<SempDriftDto>().map { dto ->
            SempDrift(dto.guidanceUpdatedAt, dto.findings.mapNotNull { it.toDomain() })
        }

    override suspend fun resolveDrift(
        projectId: String,
        findingId: String,
        choice: SempDriftChoice,
        expectedGuidanceUpdatedAt: String?,
    ): RepositoryResult<SempGuidanceSave> {
        val wire = when (choice) {
            SempDriftChoice.ALLOW -> "allow"
            SempDriftChoice.FORBID -> "forbid"
            SempDriftChoice.DISMISS -> "dismiss"
        }
        val body = buildJsonObject {
            put("choice", wire)
            put("expectedGuidanceUpdatedAt", expectedGuidanceUpdatedAt)
        }.toString()
        val response = api.send(HttpMethod.Post, "/api/agent-guidance-drift/$findingId/resolve", body = body)
        return when (response) {
            is ApiResponse.Success -> response.decode<SempDriftResolveDto>().map {
                SempGuidanceSave.Saved(it.guidance.toDomain())
            }
            is ApiResponse.Failure -> savedOrConflict(projectId, response)
        }
    }

    override suspend fun grants(projectId: String): RepositoryResult<List<SempToolGrant>> =
        api.send(HttpMethod.Get, "/api/projects/$projectId/mcp-grants").decode<SempGrantListDto>().map { list ->
            list.rows.map {
                SempToolGrant(
                    registrationId = it.mcpToolRegistrationId,
                    label = it.displayLabel ?: it.toolName,
                    toolName = it.toolName,
                    requiresApproval = it.requiresApproval,
                    granted = it.granted,
                    serverId = it.mcpServerItemId,
                    serverName = it.mcpServerName,
                    serverOnline = it.mcpServerOnline,
                )
            }
        }

    override suspend fun setGrant(projectId: String, registrationId: String, granted: Boolean): RepositoryResult<Unit> =
        api.send(
            HttpMethod.Patch,
            "/api/projects/$projectId/mcp-grants/$registrationId",
            body = ApiJson.encodeToString(SempGrantBody(granted)),
        ).ignoreBody()

    override suspend fun tasks(projectId: String): RepositoryResult<List<SempProjectTask>> =
        api.send(HttpMethod.Get, "/api/projects/$projectId/heartbeats").decode<SempTaskListDto>().map { list ->
            list.rows.map { it.toDomain() }
        }

    override suspend fun setTaskEnabled(taskId: String, enabled: Boolean): RepositoryResult<Unit> =
        api.send(HttpMethod.Patch, "/api/heartbeats/$taskId", body = ApiJson.encodeToString(SempEnabledBody(enabled)))
            .ignoreBody()

    override suspend fun runTask(taskId: String): RepositoryResult<Unit> =
        api.send(HttpMethod.Post, "/api/heartbeats/$taskId/trigger").ignoreBody()

    private suspend fun savedOrConflict(projectId: String, response: ApiResponse): RepositoryResult<SempGuidanceSave> =
        when {
            response is ApiResponse.Failure && response.status == CONFLICT_STATUS ->
                guidance(projectId).map { SempGuidanceSave.Conflict(it) }
            else -> response.decode<SempGuidanceDto>().map { SempGuidanceSave.Saved(it.toDomain()) }
        }
}

private fun SempGuidanceDto.toDomain() = SempGuidanceDocument(
    SempGuidance(sections.purpose, sections.allowed, sections.notAllowed, sections.generalInstructions),
    updatedAt,
)

private fun SempGuidance.toDto() = SempGuidanceSectionsDto(purpose, allowed, notAllowed, general)

private fun SempDriftFindingDto.toDomain(): SempDriftFinding? {
    val driftKind = when (kind) {
        "permission" -> SempDriftKind.PERMISSION
        "behavior" -> SempDriftKind.BEHAVIOR
        else -> return null
    }
    return SempDriftFinding(id, driftKind, claim, severity == "blocking", suggestedAllowedLine, suggestedNotAllowedLine)
}

private fun SempTaskDto.toDomain() = SempProjectTask(
    id = id,
    name = name,
    ruleLabel = ruleLabel,
    enabled = enabled,
    threadId = threadId,
    lastAt = lastOccurrence?.at,
    lastFailed = lastOccurrence?.status == "failed",
    lastWaiting = lastOccurrence?.status == "waiting_approval",
    lastErrorSummary = lastOccurrence?.errorSummary,
)
