package cz.alldots.app.data

import cz.alldots.app.core.CapturedAudio
import cz.alldots.app.core.FailureKind
import cz.alldots.app.core.RecordingPairing
import cz.alldots.app.core.RecordingStatus
import cz.alldots.app.domain.RecordingEntry
import cz.alldots.app.domain.RepositoryResult
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpMethod
import io.ktor.http.HttpStatusCode
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertContentEquals
import kotlin.test.assertEquals
import kotlin.test.assertIs

private const val LIST = """{"transcripts":[
  {"id":"a","displayName":"Client meeting","suggestedName":null,"date":"2026-10-16T10:02:00+02:00",
   "durationSeconds":4867.4,"status":"done","pairing":"event","event":{"id":"e1","name":"Client meeting"},
   "proposalId":null,"shortSummary":"Budget agreed.","openQuestions":{"count":0,"first":null},"automation":null},
  {"id":"b","displayName":"Recording 14. 10. 13:52","date":null,"durationSeconds":null,"status":"processing",
   "pairing":"processing","event":null,"shortSummary":"  "},
  {"id":"c","displayName":"C","status":"brand-new","pairing":"somethingNew"}
],"nextCursor":null}"""

private val AUDIO = CapturedAudio("/tmp/take.m4a", "take.m4a", "audio/mp4", "2026-10-16T10:00:00+02:00", 42)

class HttpRecordingsRepositoryTest {
    private fun recorder(
        status: HttpStatusCode = HttpStatusCode.OK,
        body: String = "{}"
    ) = Recorder { json(body, status) }

    @Test
    fun `the recordings are listed newest first with the event they belong to`() = runTest {
        val recorder = recorder(body = LIST)

        val entries = assertIs<RepositoryResult.Content<List<RecordingEntry>>>(
            HttpRecordingsRepository(recorder.api).list(eventId = null),
        ).value

        val request = recorder.requests.single()
        assertEquals(HttpMethod.Get, request.method)
        assertEquals("/api/transcripts", request.url.encodedPath)
        assertEquals("100", request.url.parameters["limit"])
        assertEquals(null, request.url.parameters["eventId"])
        assertEquals(listOf("a", "b", "c"), entries.map { it.id })
        val first = entries[0]
        assertEquals("Client meeting", first.name)
        assertEquals(4867, first.durationSeconds)
        assertEquals(RecordingStatus.DONE, first.status)
        assertEquals(RecordingPairing.EVENT, first.pairing)
        assertEquals("e1", first.eventId)
        assertEquals("Client meeting", first.eventName)
        assertEquals("Budget agreed.", first.shortSummary)
    }

    @Test
    fun `a recording in process and one the app does not know are read without failing`() = runTest {
        val entries = assertIs<RepositoryResult.Content<List<RecordingEntry>>>(
            HttpRecordingsRepository(recorder(body = LIST).api).list(null),
        ).value

        assertEquals(RecordingStatus.PROCESSING, entries[1].status)
        assertEquals(RecordingPairing.PROCESSING, entries[1].pairing)
        assertEquals(null, entries[1].shortSummary)
        assertEquals(null, entries[1].date)
        assertEquals(null, entries[2].status)
        assertEquals(RecordingPairing.NONE, entries[2].pairing)
    }

    @Test
    fun `the recordings of an event are asked for by its id`() = runTest {
        val recorder = recorder(body = """{"transcripts":[]}""")

        val entries = assertIs<RepositoryResult.Content<List<RecordingEntry>>>(
            HttpRecordingsRepository(recorder.api).list("e1"),
        ).value

        assertEquals("e1", recorder.requests.single().url.parameters["eventId"])
        assertEquals(emptyList(), entries)
    }

    @Test
    fun `a list that is not a list and a refused list are failures`() = runTest {
        assertEquals(
            RepositoryResult.Failure(FailureKind.INVALID_DATA),
            HttpRecordingsRepository(recorder(body = "[]").api).list(null),
        )
        assertEquals(
            RepositoryResult.Failure(FailureKind.UNAVAILABLE),
            HttpRecordingsRepository(recorder(HttpStatusCode.InternalServerError).api).list(null),
        )
    }

    @Test
    fun `an upload sends the bytes with the file name the time and the event`() = runTest {
        val recorder = recorder(HttpStatusCode.Created, """{"fileItemId":"f1","created":true,"transcriptId":null}""")
        val repository =
            HttpRecordingsRepository(recorder.api) { path -> if (path == AUDIO.path) byteArrayOf(1, 2, 3) else null }

        val result = repository.upload(AUDIO, "e1")

        assertEquals(RepositoryResult.Content(Unit), result)
        val request = recorder.requests.single()
        assertEquals(HttpMethod.Post, request.method)
        assertEquals("/api/recordings", request.url.encodedPath)
        assertEquals("audio/mp4", request.body.contentType.toString())
        assertEquals("take.m4a", request.headers["X-Filename"])
        assertEquals("2026-10-16T10:00:00+02:00", request.headers["X-Recorded-At"])
        assertEquals("e1", request.headers["X-Event-Id"])
        assertEquals("Bearer tok", request.headers[HttpHeaders.Authorization])
        assertContentEquals(byteArrayOf(1, 2, 3), recorder.bodies.single())
    }

    @Test
    fun `an upload without an event names none`() = runTest {
        val recorder = recorder(HttpStatusCode.Created)

        HttpRecordingsRepository(recorder.api) { byteArrayOf(9) }.upload(AUDIO, null)

        assertEquals(null, recorder.requests.single().headers["X-Event-Id"])
    }

    @Test
    fun `a file that cannot be read is not found and nothing is sent`() = runTest {
        val recorder = recorder()

        val result = HttpRecordingsRepository(recorder.api) { null }.upload(AUDIO, null)

        assertEquals(RepositoryResult.Failure(FailureKind.NOT_FOUND), result)
        assertEquals(0, recorder.requests.size)
    }

    @Test
    fun `an upload the server refuses is a failure of the kind it maps to`() = runTest {
        val refused = HttpRecordingsRepository(recorder(HttpStatusCode.Conflict).api) { byteArrayOf(1) }
        val tooBig = HttpRecordingsRepository(recorder(HttpStatusCode.PayloadTooLarge).api) { byteArrayOf(1) }
        val unknownEvent = HttpRecordingsRepository(recorder(HttpStatusCode.NotFound).api) { byteArrayOf(1) }

        assertEquals(RepositoryResult.Failure(FailureKind.REJECTED), refused.upload(AUDIO, "e1"))
        assertEquals(RepositoryResult.Failure(FailureKind.INVALID_DATA), tooBig.upload(AUDIO, "e1"))
        assertEquals(RepositoryResult.Failure(FailureKind.NOT_FOUND), unknownEvent.upload(AUDIO, "e1"))
    }
}
