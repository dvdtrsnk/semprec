package cz.alldots.app.data

import cz.alldots.app.core.CapturedAudio
import cz.alldots.app.core.FailureKind
import cz.alldots.app.domain.RecordingEntry
import cz.alldots.app.domain.RecordingsRepository
import cz.alldots.app.domain.RepositoryResult
import cz.alldots.app.domain.map
import io.ktor.http.HttpMethod

private const val PAGE_LIMIT = "100"

/**
 * The recordings of the server: `GET /api/transcripts` lists them and `POST /api/recordings` takes the audio, which
 * the server transcribes by itself (a second request for the transcription would be refused as a duplicate).
 * [readFile] reads the file of a recording; tests pass their own.
 */
class HttpRecordingsRepository internal constructor(
    private val api: AuthenticatedApi,
    private val readFile: (String) -> ByteArray?,
) : RecordingsRepository {
    constructor(api: AuthenticatedApi) : this(api, ::readRecordedFile)

    override suspend fun list(eventId: String?): RepositoryResult<List<RecordingEntry>> {
        val query = buildList {
            add("limit" to PAGE_LIMIT)
            eventId?.let { add("eventId" to it) }
        }
        return api.send(HttpMethod.Get, "/api/transcripts", query).decode<RecordingPageDto>()
            .map { page -> page.transcripts.map { it.toEntry() } }
    }

    override suspend fun upload(audio: CapturedAudio, eventId: String?): RepositoryResult<Unit> {
        val bytes = readFile(audio.path) ?: return RepositoryResult.Failure(FailureKind.NOT_FOUND)
        val headers = buildList {
            add("X-Filename" to audio.fileName)
            add("X-Recorded-At" to audio.recordedAt)
            eventId?.let { add("X-Event-Id" to it) }
        }
        return api.upload("/api/recordings", RawBody(audio.mimeType, bytes), headers).ignoreBody()
    }
}
