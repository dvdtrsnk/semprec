package cz.alldots.app.data

import cz.alldots.app.domain.MailSignalAssignment
import cz.alldots.app.domain.MailSignalPerson
import cz.alldots.app.domain.MailSignalPreview
import cz.alldots.app.domain.MailSignalSet
import cz.alldots.app.domain.MailSignalsOutcome
import cz.alldots.app.domain.ProjectMailSignals
import cz.alldots.app.domain.ProjectMailSignalsRepository
import cz.alldots.app.domain.RepositoryResult
import cz.alldots.app.domain.map
import io.ktor.http.HttpMethod
import kotlinx.serialization.encodeToString

/**
 * A project's mail signals over `/api/mail/projects/:projectId/signals`. A save or a preview the server refused for
 * one of the lists is [MailSignalsOutcome.Invalid] naming it; any other refusal is a failure.
 */
class HttpProjectMailSignalsRepository(private val api: AuthenticatedApi) : ProjectMailSignalsRepository {

    override suspend fun signals(projectId: String): RepositoryResult<ProjectMailSignals> =
        api.send(HttpMethod.Get, path(projectId)).decode<ProjectMailSignalsDto>().map { it.toDomain() }

    override suspend fun save(
        projectId: String,
        signals: MailSignalSet,
    ): RepositoryResult<MailSignalsOutcome<ProjectMailSignals>> {
        val response = api.send(HttpMethod.Put, path(projectId), body = ApiJson.encodeToString(signals.toBody()))
        return outcome(response) { it.decode<ProjectMailSignalsDto>().map { dto -> dto.toDomain() } }
    }

    override suspend fun preview(
        projectId: String,
        draft: MailSignalSet?,
    ): RepositoryResult<MailSignalsOutcome<MailSignalPreview>> {
        val body = draft?.let { ApiJson.encodeToString(MailSignalPreviewBody(it.toBody())) } ?: "{}"
        val response = api.send(HttpMethod.Post, "${path(projectId)}/preview", body = body)
        return outcome(response) { success ->
            success.decode<MailSignalPreviewDto>().map { dto ->
                MailSignalPreview(dto.total, dto.alreadyAssigned, dto.threads.map { it.toDomain() })
            }
        }
    }

    override suspend fun apply(projectId: String, threadIds: List<String>): RepositoryResult<MailSignalAssignment> =
        api.send(
            HttpMethod.Post,
            "${path(projectId)}/apply",
            body = ApiJson.encodeToString(MailSignalApplyBody(threadIds)),
        ).decode<MailSignalAssignmentDto>().map { MailSignalAssignment(it.assigned, it.skipped) }

    private fun path(projectId: String) = "/api/mail/projects/$projectId/signals"

    private fun <T> outcome(
        response: ApiResponse,
        content: (ApiResponse) -> RepositoryResult<T>,
    ): RepositoryResult<MailSignalsOutcome<T>> {
        val field = (response as? ApiResponse.Failure)?.invalidSignalField()
        return if (field != null) {
            RepositoryResult.Content(MailSignalsOutcome.Invalid(field))
        } else {
            content(response).map { MailSignalsOutcome.Done(it) }
        }
    }
}

private fun MailSignalSet.toBody() = MailSignalSetBody(domains, addresses, keywords)

private fun ProjectMailSignalsDto.toDomain() = ProjectMailSignals(
    projectId = projectId,
    signals = MailSignalSet(domains, addresses, keywords),
    updatedAt = updatedAt,
    people = peopleAddresses.map { MailSignalPerson(it.personId, it.name, it.address) },
)
