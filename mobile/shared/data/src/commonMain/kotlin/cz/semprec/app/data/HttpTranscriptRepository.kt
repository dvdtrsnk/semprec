package cz.semprec.app.data

import cz.semprec.app.core.FailureKind
import cz.semprec.app.core.PlaybackSource
import cz.semprec.app.domain.RepositoryResult
import cz.semprec.app.domain.TranscriptCandidate
import cz.semprec.app.domain.TranscriptDetail
import cz.semprec.app.domain.TranscriptRepository
import cz.semprec.app.domain.map
import io.ktor.http.HttpMethod
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/**
 * The transcript routes of the server: `/api/transcripts/:id` and what hangs off it (speakers, action items), and
 * the blob the audio streams from.
 */
class HttpTranscriptRepository(private val api: AuthenticatedApi) : TranscriptRepository {

    override suspend fun detail(transcriptId: String): RepositoryResult<TranscriptDetail> =
        api.send(HttpMethod.Get, "/api/transcripts/$transcriptId").decode<TranscriptDetailDto>().map { it.toDetail() }

    override suspend fun candidates(transcriptId: String): RepositoryResult<List<TranscriptCandidate>> =
        api.send(HttpMethod.Get, "/api/transcripts/$transcriptId/speaker-candidates")
            .decode<TranscriptCandidatesDto>()
            .map { found -> found.participants.map { it.toCandidate() } }

    override suspend fun assignSpeaker(
        transcriptId: String,
        speaker: String,
        personId: String?,
    ): RepositoryResult<Unit> {
        val body = buildJsonObject { put("personId", personId?.let(::JsonPrimitive) ?: JsonNull) }
        return api.send(HttpMethod.Put, "/api/transcripts/$transcriptId/speakers/$speaker", body = body.toString())
            .ignoreBody()
    }

    override suspend fun note(transcriptId: String, actionItemId: Int, noted: Boolean): RepositoryResult<Unit> {
        val body = buildJsonObject { put("state", if (noted) JsonPrimitive("noted") else JsonNull) }
        return api.send(
            HttpMethod.Put,
            "/api/transcripts/$transcriptId/action-items/$actionItemId/state",
            body = body.toString(),
        ).ignoreBody()
    }

    override suspend fun addTask(transcriptId: String, actionItemId: Int): RepositoryResult<Unit> =
        api.send(
            HttpMethod.Post,
            "/api/transcripts/$transcriptId/action-items/$actionItemId/task",
            body = buildJsonObject { }.toString(),
        ).ignoreBody()

    override suspend fun removeTask(transcriptId: String, actionItemId: Int): RepositoryResult<Unit> =
        api.send(HttpMethod.Delete, "/api/transcripts/$transcriptId/action-items/$actionItemId/task").ignoreBody()

    override suspend fun playback(blobId: String): RepositoryResult<PlaybackSource> {
        val session = api.session() ?: return RepositoryResult.Failure(FailureKind.UNAUTHORIZED)
        val url = "${session.serverUrl}/api/blobs/$blobId"
        return RepositoryResult.Content(PlaybackSource(url, "Bearer ${session.token}"))
    }
}
