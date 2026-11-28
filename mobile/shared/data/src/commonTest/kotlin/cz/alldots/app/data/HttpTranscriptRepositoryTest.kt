package cz.alldots.app.data

import cz.alldots.app.core.FailureKind
import cz.alldots.app.core.InMemorySessionStorage
import cz.alldots.app.core.PlaybackSource
import cz.alldots.app.core.RecordingStatus
import cz.alldots.app.core.TranscriptActionState
import cz.alldots.app.domain.RepositoryResult
import cz.alldots.app.domain.TranscriptCandidate
import cz.alldots.app.domain.TranscriptDetail
import io.ktor.client.engine.mock.MockEngine
import io.ktor.http.HttpMethod
import io.ktor.http.HttpStatusCode
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonPrimitive
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertIs
import kotlin.test.assertNull

private const val DETAIL = """{
 "id":"tr-1","displayName":"Client meeting","suggestedName":null,"date":"2026-10-16T10:02:00+02:00",
 "durationSeconds":4867,"finalizedAt":"2026-10-16T12:00:00Z","language":"cs","speakerCount":2,
 "speakers":[{"speaker":"SPEAKER_00","ordinal":1,"label":"David","personId":"p1","firstStartsAt":245.0},
             {"speaker":"SPEAKER_01","ordinal":2,"label":"Mluvci 2","personId":null,"firstStartsAt":262.5}],
 "segments":[{"index":0,"speaker":"SPEAKER_00","text":"Hello.","startsAt":245.0,"endsAt":250.0,"label":"David"},
             {"index":1,"speaker":"SPEAKER_01","text":"Hi.","startsAt":262.5,"endsAt":270.0,"label":"Mluvci 2"}],
 "meetingNotes":{"title":"T","summary":"Budget agreed.","shortSummary":"S","decisions":["Blog later"],
   "actionItems":[
     {"id":0,"text":"Send offer","ownerSpeaker":"SPEAKER_00","ownerLabel":"David","due":"2026-10-23","startsAt":null,
      "state":"open","taskId":null,"isMine":true},
     {"id":1,"text":"Logos","ownerSpeaker":null,"ownerLabel":null,"due":null,"startsAt":300.0,
      "state":"added","taskId":"t9","isMine":false},
     {"id":2,"text":"Wire","state":"noted"},{"id":3,"text":"X","state":"dismissed"},
     {"id":4,"text":"Y","state":"future"}]},
 "notes":null,"event":{"id":"e1","name":"Client meeting","date":"2026-10-16"},
 "context":{"project":{"id":"pr1","name":"Web","valueKind":"inherited","sources":[]},
            "company":{"id":"c1","name":"Novak","valueKind":"derived","sources":[]},
            "people":[{"personId":"p2","name":"Petr","valueKind":"own","sources":[]},{"name":"No id"}]},
 "playback":{"blobId":"blob-1","mimeType":"audio/mp4"},
 "automation":{"status":"done","attempts":1,"lastAttemptAt":null,"errorCode":null},
 "openQuestions":{"count":1,"first":null}}"""

class HttpTranscriptRepositoryTest {
    private fun recorder(
        status: HttpStatusCode = HttpStatusCode.OK,
        body: String = "{}"
    ) = Recorder { json(body, status) }

    @Test
    fun `the detail carries the segments the speakers the notes the context and the audio`() = runTest {
        val recorder = recorder(body = DETAIL)

        val detail = assertIs<RepositoryResult.Content<TranscriptDetail>>(
            HttpTranscriptRepository(recorder.api).detail("tr-1"),
        ).value

        val request = recorder.requests.single()
        assertEquals(HttpMethod.Get, request.method)
        assertEquals("/api/transcripts/tr-1", request.url.encodedPath)
        assertEquals("Client meeting", detail.name)
        assertEquals(4867, detail.durationSeconds)
        assertEquals("cs", detail.language)
        assertEquals(RecordingStatus.DONE, detail.status)
        assertEquals(listOf("SPEAKER_00" to "p1", "SPEAKER_01" to null), detail.speakers.map { it.key to it.personId })
        assertEquals(listOf(245.0, 262.5), detail.segments.map { it.startsAt })
        assertEquals("Mluvci 2", detail.segments[1].label)
        assertEquals("e1", detail.event?.id)
        assertEquals("blob-1", detail.blobId)
        assertEquals("Budget agreed.", detail.notes?.summary)
        assertEquals(listOf("Blog later"), detail.notes?.decisions)
    }

    @Test
    fun `the action items read their state owner and task and an unknown state is open`() = runTest {
        val detail = assertIs<RepositoryResult.Content<TranscriptDetail>>(
            HttpTranscriptRepository(recorder(body = DETAIL).api).detail("tr-1"),
        ).value

        val items = detail.notes?.actionItems.orEmpty()
        assertEquals(
            listOf(
                TranscriptActionState.OPEN,
                TranscriptActionState.ADDED,
                TranscriptActionState.NOTED,
                TranscriptActionState.DISMISSED,
                TranscriptActionState.OPEN,
            ),
            items.map { it.state },
        )
        assertEquals("David", items[0].ownerLabel)
        assertEquals("2026-10-23", items[0].due)
        assertEquals(true, items[0].isMine)
        assertEquals("t9", items[1].taskId)
        assertEquals(false, items[2].isMine)
    }

    @Test
    fun `the context says what follows the event and a person without an id is left out`() = runTest {
        val detail = assertIs<RepositoryResult.Content<TranscriptDetail>>(
            HttpTranscriptRepository(recorder(body = DETAIL).api).detail("tr-1"),
        ).value

        assertEquals(true, detail.context.project?.inherited)
        assertEquals("Web", detail.context.project?.name)
        assertEquals(false, detail.context.company?.inherited)
        assertEquals(listOf("p2"), detail.context.people.map { it.id })
        assertEquals(false, detail.context.people.single().inherited)
    }

    @Test
    fun `a transcript still being made has no segments so it is processing or an error`() = runTest {
        val running = """{"id":"a","displayName":"X","automation":{"status":"pending"}}"""
        val failed = """{"id":"a","displayName":"X","automation":{"status":"error"}}"""
        val bare = """{"id":"a"}"""

        val results = listOf(running, failed, bare).map {
            assertIs<RepositoryResult.Content<TranscriptDetail>>(
                HttpTranscriptRepository(recorder(body = it).api).detail("a"),
            ).value
        }

        assertEquals(
            listOf(RecordingStatus.PROCESSING, RecordingStatus.ERROR, RecordingStatus.PROCESSING),
            results.map { it.status },
        )
        assertNull(results[0].blobId)
        assertNull(results[0].notes)
        assertNull(results[0].event)
        assertEquals(emptyList(), results[0].segments)
    }

    @Test
    fun `a missing transcript and an unreadable one are failures`() = runTest {
        assertEquals(
            RepositoryResult.Failure(FailureKind.NOT_FOUND),
            HttpTranscriptRepository(recorder(HttpStatusCode.NotFound).api).detail("x"),
        )
        assertEquals(
            RepositoryResult.Failure(FailureKind.INVALID_DATA),
            HttpTranscriptRepository(recorder(body = "[]").api).detail("x"),
        )
    }

    @Test
    fun `the candidates are the participants with the voice they already are`() = runTest {
        val recorder = recorder(
            body = """{"participants":[{"personId":"p1","name":"Jana","title":null,"mappedSpeaker":null},
                {"personId":"p2","name":null,"mappedSpeaker":"SPEAKER_01"}],"self":null}""",
        )

        val candidates = assertIs<RepositoryResult.Content<List<TranscriptCandidate>>>(
            HttpTranscriptRepository(recorder.api).candidates("tr-1"),
        ).value

        assertEquals("/api/transcripts/tr-1/speaker-candidates", recorder.requests.single().url.encodedPath)
        assertEquals(
            listOf(TranscriptCandidate("p1", "Jana", null), TranscriptCandidate("p2", "", "SPEAKER_01")),
            candidates,
        )
    }

    @Test
    fun `a voice is given to a person or released with a null`() = runTest {
        val recorder = recorder(body = """{"speaker":"SPEAKER_01","label":"Jana","personId":"p1"}""")
        val repository = HttpTranscriptRepository(recorder.api)

        assertEquals(RepositoryResult.Content(Unit), repository.assignSpeaker("tr-1", "SPEAKER_01", "p1"))
        assertEquals(RepositoryResult.Content(Unit), repository.assignSpeaker("tr-1", "SPEAKER_01", null))

        assertEquals(listOf(HttpMethod.Put, HttpMethod.Put), recorder.requests.map { it.method })
        assertEquals("/api/transcripts/tr-1/speakers/SPEAKER_01", recorder.requests[0].url.encodedPath)
        assertEquals(JsonPrimitive("p1"), recorder.bodyJson(0)["personId"])
        assertEquals(JsonNull, recorder.bodyJson(1)["personId"])
    }

    @Test
    fun `following an action item and opening it again are the state route`() = runTest {
        val recorder = recorder(body = """{"actionItemId":2,"state":"noted"}""")
        val repository = HttpTranscriptRepository(recorder.api)

        repository.note("tr-1", 2, noted = true)
        repository.note("tr-1", 2, noted = false)

        assertEquals("/api/transcripts/tr-1/action-items/2/state", recorder.requests[0].url.encodedPath)
        assertEquals(HttpMethod.Put, recorder.requests[0].method)
        assertEquals(JsonPrimitive("noted"), recorder.bodyJson(0)["state"])
        assertEquals(JsonNull, recorder.bodyJson(1)["state"])
    }

    @Test
    fun `a task is made of an action item and taken back`() = runTest {
        val recorder = recorder(HttpStatusCode.Created, """{"taskId":"t1"}""")
        val repository = HttpTranscriptRepository(recorder.api)

        assertEquals(RepositoryResult.Content(Unit), repository.addTask("tr-1", 3))
        assertEquals(RepositoryResult.Content(Unit), repository.removeTask("tr-1", 3))

        assertEquals(HttpMethod.Post, recorder.requests[0].method)
        assertEquals("/api/transcripts/tr-1/action-items/3/task", recorder.requests[0].url.encodedPath)
        assertEquals("{}", recorder.bodies[0].decodeToString())
        assertEquals(HttpMethod.Delete, recorder.requests[1].method)
        assertEquals("/api/transcripts/tr-1/action-items/3/task", recorder.requests[1].url.encodedPath)
    }

    @Test
    fun `a refused action item write is a failure and an action item that is gone is not found`() = runTest {
        val refused = HttpTranscriptRepository(recorder(HttpStatusCode.BadRequest).api)
        val gone = HttpTranscriptRepository(recorder(HttpStatusCode.NotFound).api)

        assertEquals(RepositoryResult.Failure(FailureKind.REJECTED), refused.note("t", 0, noted = true))
        assertEquals(RepositoryResult.Failure(FailureKind.NOT_FOUND), gone.addTask("t", 0))
        assertEquals(RepositoryResult.Failure(FailureKind.NOT_FOUND), gone.removeTask("t", 0))
        assertEquals(RepositoryResult.Failure(FailureKind.NOT_FOUND), gone.assignSpeaker("t", "S", null))
    }

    @Test
    fun `the audio streams from the blob of the server with the bearer token`() = runTest {
        val recorder = recorder()

        val source = assertIs<RepositoryResult.Content<PlaybackSource>>(
            HttpTranscriptRepository(recorder.api).playback("blob-1"),
        ).value

        assertEquals("https://s.example/api/blobs/blob-1", source.url)
        assertEquals("Bearer tok", source.authorization)
        assertEquals(0, recorder.requests.size)
    }

    @Test
    fun `without a session there is no audio to stream`() = runTest {
        val signedOut = AuthenticatedApi(ApiClient(MockEngine { error("never called") }), InMemorySessionStorage()) {}

        val result = HttpTranscriptRepository(signedOut).playback("b")

        assertEquals(RepositoryResult.Failure(FailureKind.UNAUTHORIZED), result)
    }
}
