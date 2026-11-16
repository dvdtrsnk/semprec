package cz.semprec.app.data

import cz.semprec.app.domain.RepositoryResult
import cz.semprec.app.domain.SempProblem
import cz.semprec.app.domain.SempProblemAction
import cz.semprec.app.domain.SempProblemSeverity
import cz.semprec.app.domain.SempResolvedProblem
import cz.semprec.app.domain.SempService
import cz.semprec.app.domain.SempStatusReport
import cz.semprec.app.domain.SempStatusRepository
import cz.semprec.app.domain.SempStatusSummary
import cz.semprec.app.domain.map
import io.ktor.http.HttpMethod
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull

private const val STATUS_PATH = "/api/semp-status"
private const val STATE_ERROR = "error"

@Serializable
internal data class SempStatusDto(
    val activeCount: Int,
    val services: List<SempServiceDto> = emptyList(),
    val problems: List<SempProblemDto> = emptyList(),
    val resolvedRecent: List<SempResolvedProblemDto> = emptyList(),
)

@Serializable
internal data class SempServiceDto(
    val key: String,
    val name: String,
    val state: String,
    val since: String? = null,
    val lastActivityAt: String? = null,
)

@Serializable
internal data class SempProblemDto(
    val id: String,
    val category: String,
    val severity: String,
    val title: String,
    val text: String,
    val shortText: String,
    val since: String? = null,
    val mergedCount: Int = 1,
    val projectName: String? = null,
    val actions: List<SempActionDto> = emptyList(),
)

/** `target` is an id, or `{ threadId, messageId }` for the chat of a failed reply. */
@Serializable
internal data class SempActionDto(val kind: String, val target: JsonElement)

@Serializable
internal data class SempResolvedProblemDto(val id: String, val resolutionTitle: String, val resolvedAt: String)

@Serializable
internal data class SempStatusSummaryDto(val activeCount: Int, val banner: SempBannerDto? = null)

@Serializable
internal data class SempBannerDto(val problemId: String, val title: String, val shortText: String)

/** The status report of Semp (`GET /api/semp-status`) and the count and notice of its summary. */
class HttpSempStatusRepository(private val api: AuthenticatedApi) : SempStatusRepository {

    override suspend fun report(): RepositoryResult<SempStatusReport> =
        api.send(HttpMethod.Get, STATUS_PATH).decode<SempStatusDto>().map { it.toDomain() }

    override suspend fun summary(): RepositoryResult<SempStatusSummary> =
        api.send(HttpMethod.Get, "$STATUS_PATH/summary").decode<SempStatusSummaryDto>().map {
            SempStatusSummary(it.activeCount, it.banner?.problemId, it.banner?.title, it.banner?.shortText)
        }
}

private fun SempStatusDto.toDomain() = SempStatusReport(
    activeCount = activeCount,
    services = services.map {
        SempService(it.key, it.name, it.since.takeIf { _ -> it.state == STATE_ERROR }, it.lastActivityAt)
    },
    problems = problems.map { it.toDomain() },
    resolved = resolvedRecent.map { SempResolvedProblem(it.id, it.resolutionTitle, it.resolvedAt) },
)

private fun SempProblemDto.toDomain() = SempProblem(
    id = id,
    category = category,
    severity = if (severity == "critical") SempProblemSeverity.CRITICAL else SempProblemSeverity.WARNING,
    title = title,
    text = text,
    shortText = shortText,
    since = since,
    mergedCount = mergedCount,
    projectName = projectName,
    actions = actions.toDomain(),
)

private fun JsonElement.asId(): String? = (this as? JsonPrimitive)?.contentOrNull

private fun JsonElement.asChatTarget(): Pair<String, String>? {
    val target = this as? JsonObject ?: return null
    val thread = (target["threadId"] as? JsonPrimitive)?.contentOrNull
    val message = (target["messageId"] as? JsonPrimitive)?.contentOrNull
    return if (thread != null && message != null) thread to message else null
}

/**
 * The actions this app can carry out. `retryPrompt` names only the message, so it is paired with the thread of the
 * `openChat` action of the same problem; mailbox sign-in and transcription retries have no flow in the app and are
 * left out.
 */
private fun List<SempActionDto>.toDomain(): List<SempProblemAction> {
    val chat = firstNotNullOfOrNull { if (it.kind == "openChat") it.target.asChatTarget() else null }
    return mapNotNull { action ->
        when (action.kind) {
            "retryRun" -> action.target.asId()?.let(SempProblemAction::RetryRun)
            "retryPrompt" -> chat?.let { SempProblemAction.RetryPrompt(it.first, it.second) }
            "openChat" -> action.target.asChatTarget()?.let { SempProblemAction.OpenChat(it.first, it.second) }
            "openThread" -> action.target.asId()?.let(SempProblemAction::OpenThread)
            "disableHeartbeat" -> action.target.asId()?.let(SempProblemAction::DisableHeartbeat)
            "openProject" -> action.target.asId()?.let(SempProblemAction::OpenProject)
            else -> null
        }
    }
}
