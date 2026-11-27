package cz.semprec.app.data

import cz.semprec.app.core.FailureKind
import cz.semprec.app.domain.InboxCard
import cz.semprec.app.domain.InboxCardKind
import cz.semprec.app.domain.InboxCardStatus
import cz.semprec.app.domain.InboxContext
import cz.semprec.app.domain.InboxControl
import cz.semprec.app.domain.InboxEdit
import cz.semprec.app.domain.InboxEntityKind
import cz.semprec.app.domain.InboxOrigin
import cz.semprec.app.domain.InboxPropertyType
import cz.semprec.app.domain.InboxRevision
import cz.semprec.app.domain.InboxRisk
import cz.semprec.app.domain.InboxStack
import cz.semprec.app.domain.InboxValue
import cz.semprec.app.domain.RepositoryResult
import io.ktor.http.HttpMethod
import io.ktor.http.HttpStatusCode
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertIs
import kotlin.test.assertNull
import kotlin.test.assertTrue

private const val TASKS_DB = "cccccccc-0000-4000-8000-000000000001"
private const val CARD = "dddddddd-0000-4000-8000-000000000001"
private const val VERSION = "3"
private const val NEWER = "4"
private const val UPDATED_AT = "2026-10-16T08:05:00.000Z"

private const val TASKS_SCHEMA = """{"tenant":{"timezone":"Europe/Prague","today":"2026-10-16"},"databases":[
  {"databaseId":"$TASKS_DB","key":"tasks","name":"Tasks","defaultSort":{"system":"createdAt","direction":"desc"},
   "quickFilters":[],"properties":[
   {"id":"t1","type":"title","key":"name","name":"Name","owner":"user","config":{}},
   {"id":"t2","type":"select","key":"status","name":"Status","owner":"user","config":{},
    "options":[{"key":"todo","label":"To do","color":"#007AFF"},{"key":"done","label":"Done"}]},
   {"id":"t3","type":"relation","key":"project","name":"Project","owner":"user",
    "config":{"targetDatabaseId":"x"}}]}]}"""

private const val TASK_CARD = """{"cardId":"$CARD","source":"proposal","cardKind":"task","baseKind":"task",
  "status":"proposed","version":"$VERSION",
  "resolvedSource":{"kind":"inboxItem","id":"i1","text":"Send the invoice","date":"2026-10-16","time":"08:12",
    "type":{"id":"ty1","name":"Task","emoji":"T"}},
  "context":null,"targets":[{"databaseKey":"tasks","label":"Tasks"}],
  "envelope":{"entityKind":"database","target":"$TASKS_DB",
    "properties":{"name":"Send the invoice","date":"2026-10-17","timeFrom":"09:00","done":false,"category":{"newOption":"Work"}},
    "relations":{"project":["p1"]}},
  "editorSchema":{"baseKind":"task","groups":[
    {"key":"main","fields":[
      {"key":"name","control":"text","label":"Name","required":true,"placeholder":"Name"},
      {"key":"date","control":"datetime","label":"Date","timeHiddenWhen":{"field":"allDay","equals":true}},
      {"key":"allDay","control":"toggle","label":"All day"},
      {"key":"status","control":"select","label":"Status"},
      {"key":"sci","control":"future","label":"Unknown control"}]},
    {"key":"links","fields":[
      {"key":"project","control":"select","label":"Project","optionsSource":"project",
        "when":{"field":"status","notEquals":"done"}}]}]}}"""

private const val INVALID_REASON = """"invalidReason":{"code":"archived","field":"project","text":"Archived"}"""

private fun cards(vararg card: String) = """{"cards":[${card.joinToString(",")}],"total":${card.size}}"""

private fun card(item: String) =
    """{"id":"$CARD","databaseId":"x","updatedAt":"$UPDATED_AT","version":"$NEWER","properties":$item}"""

class HttpInboxRepositoryTest {
    private fun fixture(handler: Handler): Pair<HttpInboxRepository, Recorder> {
        val recorder = Recorder { request ->
            if (request.url.encodedPath == "/api/schema") json(TASKS_SCHEMA) else handler(request)
        }
        return HttpInboxRepository(recorder.api, HttpCollectionReads(recorder.api)) to recorder
    }

    private suspend fun loaded(
        handler: Handler = { json(cards(TASK_CARD)) },
    ): Triple<HttpInboxRepository, Recorder, InboxCard> {
        val (repository, recorder) = fixture(handler)
        val stack = assertIs<RepositoryResult.Content<InboxStack>>(repository.stack()).value
        return Triple(repository, recorder, stack.cards.first())
    }

    @Test
    fun theStackReadsTheCardItsProposalItsEditorAndWhatTheTargetSaysOfItsProperties() = runTest {
        val (_, recorder, card) = loaded()

        assertEquals("/api/inbox/cards", recorder.requests.first().url.encodedPath)
        assertEquals(CARD, card.id)
        assertEquals(InboxCardKind.TASK, card.kind)
        assertEquals(InboxCardStatus.PROPOSED, card.status)
        assertEquals(VERSION, card.version)
        val origin = assertIs<InboxOrigin.Capture>(card.origin)
        assertEquals("i1", origin.itemId)
        assertEquals("Send the invoice", origin.text)
        assertEquals("Task", origin.typeLabel)
        val envelope = card.envelope!!
        assertEquals(InboxEntityKind.DATABASE, envelope.entityKind)
        assertEquals(InboxValue.Text("09:00"), envelope.properties["timeFrom"])
        assertEquals(InboxValue.Flag(false), envelope.properties["done"])
        assertEquals(InboxValue.NewOption("Work"), envelope.properties["category"])
        assertEquals(listOf("p1"), envelope.relations["project"])
        assertEquals(InboxPropertyType.RELATION, card.properties["project"]?.type)
        assertEquals(InboxPropertyType.SELECT, card.properties["status"]?.type)
        assertEquals(listOf("todo", "done"), card.properties["status"]?.options?.map { it.id })
    }

    @Test
    fun theEditorKeepsItsConditionsAndLeavesOutAControlThisAppDoesNotKnow() = runTest {
        val fields = loaded().third.schema!!.fields

        assertEquals(listOf("name", "date", "allDay", "status", "project"), fields.map { it.key })
        assertEquals(InboxControl.DATETIME, fields[1].control)
        val timeHidden = fields[1].timeHiddenWhen!!
        assertEquals("allDay", timeHidden.field)
        assertEquals(InboxValue.Flag(true), timeHidden.value)
        assertEquals(false, timeHidden.negated)
        assertEquals(true, fields.last().whenHolds!!.negated)
        assertEquals("project", fields.last().optionsSource)
        assertTrue(fields.first().required)
    }

    @Test
    fun theStackStillLoadsWhenTheSchemaCannotBeRead() = runTest {
        val recorder = Recorder { request ->
            if (request.url.encodedPath == "/api/schema") json("{}", HttpStatusCode.ServiceUnavailable)
            else json(cards(TASK_CARD))
        }
        val repository = HttpInboxRepository(recorder.api, HttpCollectionReads(recorder.api))

        val stack = assertIs<RepositoryResult.Content<InboxStack>>(repository.stack()).value

        assertEquals(1, stack.total)
        assertTrue(stack.cards.single().properties.isEmpty())
    }

    @Test
    fun anApprovalReadsWhatItsRequestAsksForAndAnUnknownKindCanOnlyBeDiscarded() = runTest {
        val approval = """{"cardId":"ap1","source":"approval","cardKind":"approval","baseKind":"approval",
            "status":"pending","version":null,"resolvedSource":{"kind":"run","sourceKind":"tick",
            "threadTitle":"Weekly cleanup","heartbeatName":"Cleanup"},"targets":[],"envelope":null}"""
        val future = """{"cardId":"f1","source":"proposal","cardKind":"hologram","baseKind":"hologram",
            "status":"proposed","version":"$VERSION","targets":[],"envelope":null}"""
        val (repository, recorder) = fixture { request ->
            if (request.url.encodedPath == "/api/approval-requests/ap1") {
                json(
                    """{"toolName":"generic","riskLevel":"irreversible","reason":"No longer used",
                    "safeSummary":{"kind":"genericOperation","operationName":"deleteProperty"}}"""
                )
            } else {
                json(cards(approval, future))
            }
        }
        val stack = (repository.stack() as RepositoryResult.Content).value
        assertTrue(recorder.requests.any { it.url.encodedPath == "/api/approval-requests/ap1" })

        val first = stack.cards[0]
        assertEquals(InboxCardKind.APPROVAL, first.kind)
        assertEquals(InboxCardStatus.PENDING, first.status)
        assertEquals(InboxRisk.IRREVERSIBLE, first.approval!!.risk)
        assertEquals("deleteProperty", first.approval!!.operation)
        assertEquals("No longer used", first.approval!!.reason)
        assertEquals("Weekly cleanup", (first.origin as InboxOrigin.Run).threadTitle)
        assertEquals(InboxCardKind.UNSUPPORTED, stack.cards[1].kind)
    }

    @Test
    fun aTranscriptCardThatAsksForClarificationIsThePickOfTheEventOrThePerson() = runTest {
        val speaker = """{"cardId":"s1","source":"proposal","cardKind":"clarify","baseKind":"clarify",
            "status":"needsClarification","version":"$VERSION","resolvedSource":{"kind":"transcript","name":"Call"},
            "context":{"role":"speaker","speaker":"S3","ordinal":3,"quotes":[{"segmentIndex":1,"text":"Hello"}],
            "reason":"Talks about design","alternatives":[{"personId":"pe1","name":"Jana","title":"Designer"}]},
            "targets":[],"envelope":null}"""
        val meeting = """{"cardId":"m1","source":"proposal","cardKind":"clarify","baseKind":"clarify",
            "status":"needsClarification","version":"$VERSION","resolvedSource":{"kind":"transcript"},
            "context":{"role":"event","candidates":[
            {"id":"e1","name":"Sprint","date":"2026-10-14","timeFrom":"13:30","timeTo":"14:30","endDate":null,
             "projectId":null,"projectName":"iOS"},{"seriesId":"se1","occurrenceDate":"2026-10-14"}],
            "reason":"Sprint talk","recommendedEventId":"e1","recording":{"durationSeconds":10,"speakerCount":2}},
            "targets":[],"envelope":null}"""
        val (repository) = fixture { json(cards(speaker, meeting)) }
        val stack = (repository.stack() as RepositoryResult.Content).value

        assertEquals(InboxCardKind.SPEAKER, stack.cards[0].kind)
        val context = assertIs<InboxContext.Speaker>(stack.cards[0].context)
        assertEquals("S3", context.speaker)
        assertEquals(3, context.ordinal)
        assertEquals(listOf("Hello"), context.quotes)
        assertEquals("Jana", context.alternatives.single().label)
        assertEquals(InboxCardKind.TRANSCRIPT_EVENT, stack.cards[1].kind)
        val meetingContext = assertIs<InboxContext.Meeting>(stack.cards[1].context)
        assertEquals(listOf("e1", "se1@2026-10-14"), meetingContext.candidates.map { it.id })
        assertEquals("e1", meetingContext.recommended)
        assertEquals("13:30", meetingContext.candidates[0].timeFrom)
    }

    @Test
    fun anEditSendsTheValuesTheRelationsAndTheStepsWithTheVersionAndReadsTheCardBack() = runTest {
        val item = """{"status":"proposed","proposal":{"entityKind":"database","target":"$TASKS_DB",
            "properties":{"name":"Renamed"},"relations":{"project":["p2"]}},
            "userOverrides":{"primary":{"name":"Renamed","allDay":true,"relations":{"project":["p2"]}}},
            "userEditedKeys":["primary.allDay","primary.name"]}"""
        val (repository, recorder, card) = loaded { request ->
            if (request.method == HttpMethod.Patch) json(card(item)) else json(cards(TASK_CARD))
        }

        val edit = InboxEdit(
            values = mapOf("primary" to mapOf("name" to InboxValue.Text("Renamed"), "date" to null)),
            relations = mapOf("primary" to mapOf("project" to listOf("p2"))),
            steps = mapOf("follow" to false),
        )
        val updated = (repository.edit(card, edit) as RepositoryResult.Content).value

        val request = recorder.requests.last()
        assertEquals(HttpMethod.Patch, request.method)
        assertEquals("/api/proposals/$CARD/values", request.url.encodedPath)
        val body = recorder.bodyJson(recorder.bodies.lastIndex)
        assertEquals(VERSION, body.getValue("ifVersion").jsonPrimitive.content)
        val set = body.getValue("set").jsonObject.getValue("primary").jsonObject
        assertEquals("Renamed", set.getValue("name").jsonPrimitive.content)
        assertEquals(JsonNull, set.getValue("date"))
        assertEquals(
            listOf("p2"),
            body.getValue("relations").jsonObject.getValue("primary").jsonObject.getValue("project").jsonArray
                .map { it.jsonPrimitive.content },
        )
        assertEquals(
            false,
            body.getValue("steps").jsonObject.getValue("follow").jsonObject.getValue("enabled").jsonPrimitive
                .content.toBooleanStrict(),
        )
        assertEquals(NEWER, updated.version)
        assertEquals(InboxValue.Text("Renamed"), updated.envelope!!.properties["name"])
        assertEquals(InboxValue.Flag(true), updated.userValues["primary.allDay"])
        assertEquals(setOf("primary.allDay", "primary.name"), updated.editedKeys)
        assertNull(updated.userValues["primary.relations"])
    }

    @Test
    fun theVersionAnEditAnswersIsWhatTheNextDecisionSendsNotTheUpdatedAt() = runTest {
        val (repository, recorder, card) = loaded { request ->
            when (request.method) {
                HttpMethod.Patch -> json(card("""{"status":"proposed"}"""))
                HttpMethod.Get -> json(cards(TASK_CARD))
                else -> json("{}")
            }
        }

        val updated = (repository.edit(card, InboxEdit(steps = mapOf("follow" to true))) as RepositoryResult.Content)
            .value
        repository.reject(updated)

        assertEquals("/api/proposals/$CARD/reject", recorder.requests.last().url.encodedPath)
        assertEquals(NEWER, recorder.bodyJson(recorder.bodies.lastIndex).getValue("ifVersion").jsonPrimitive.content)
    }

    @Test
    fun aValidEditLeavesAnInvalidCardProposedAndWithoutItsReason() = runTest {
        val invalid = TASK_CARD.replace("\"status\":\"proposed\"", "\"status\":\"invalid\"")
            .replace("\"editorSchema\"", "$INVALID_REASON,\"editorSchema\"")
        val (repository, _, card) = loaded { request ->
            if (request.method == HttpMethod.Patch) json(card("""{"status":"proposed"}""")) else json(cards(invalid))
        }
        assertEquals(InboxCardStatus.INVALID, card.status)
        assertEquals("Archived", card.invalid!!.text)

        val touch = InboxEdit(steps = mapOf("primary" to true))
        val updated = (repository.edit(card, touch) as RepositoryResult.Content).value

        assertEquals(InboxCardStatus.PROPOSED, updated.status)
        assertNull(updated.invalid)
    }

    @Test
    fun aRevisionReplacesTheWholeProposalTheWayTheServerReadsIt() = runTest {
        val item = """{"status":"proposed","proposal":{"entityKind":"relation","target":"pe1","properties":{}}}"""
        val (repository, recorder, card) = loaded { request ->
            if (request.method == HttpMethod.Post) json(card(item)) else json(cards(TASK_CARD))
        }

        repository.revise(card, InboxRevision.LinkSpeaker("pe1", "S3"))
        repository.revise(card, InboxRevision.LinkEvent("se1@2026-10-14"))
        repository.revise(card, InboxRevision.Page("page-2", mapOf("markdown" to InboxValue.Text("# Hi"))))

        val speaker = recorder.bodyJson(recorder.bodies.size - 3)
        assertEquals("relation", speaker.getValue("entityKind").jsonPrimitive.content)
        assertEquals("pe1", speaker.getValue("target").jsonPrimitive.content)
        val properties = speaker.getValue("properties").jsonObject
        assertEquals("speakers", properties.getValue("propertyKey").jsonPrimitive.content)
        assertEquals("S3", properties.getValue("metadata").jsonObject.getValue("speaker").jsonPrimitive.content)
        val event = recorder.bodyJson(recorder.bodies.size - 2)
        assertEquals("se1@2026-10-14", event.getValue("target").jsonPrimitive.content)
        assertEquals("event", event.getValue("properties").jsonObject.getValue("propertyKey").jsonPrimitive.content)
        val page = recorder.bodyJson(recorder.bodies.size - 1)
        assertEquals("pageContent", page.getValue("entityKind").jsonPrimitive.content)
        assertEquals("# Hi", page.getValue("properties").jsonObject.getValue("markdown").jsonPrimitive.content)
        assertEquals("/api/proposals/$CARD/revise", recorder.requests.last().url.encodedPath)
    }

    @Test
    fun aConfirmationSendsTheVersionAndTheCredentialAndNamesWhatItWrote() = runTest {
        val results = """{"id":"$CARD","properties":{},"updatedAt":"$UPDATED_AT","version":"$NEWER","results":[
            {"itemId":"x","databaseKey":"files","label":"Side","role":"secondary"},
            {"itemId":"t9","databaseKey":"tasks","label":"Send the invoice","role":"primary"}]}"""
        val (repository, recorder, card) = loaded { request ->
            if (request.method == HttpMethod.Post) json(results) else json(cards(TASK_CARD))
        }

        val outcome = (repository.confirm(card, "secret") as RepositoryResult.Content).value!!

        assertEquals("/api/proposals/$CARD/confirm", recorder.requests.last().url.encodedPath)
        val body = recorder.bodyJson(recorder.bodies.lastIndex)
        assertEquals(VERSION, body.getValue("ifVersion").jsonPrimitive.content)
        val credential = body.getValue("credential").jsonObject
        assertEquals("secret", credential.getValue("plaintext").jsonPrimitive.content)
        assertEquals("api_key", credential.getValue("credentialType").jsonPrimitive.content)
        assertEquals("Send the invoice", outcome.label)
        assertEquals("tasks", outcome.databaseKey)
        assertEquals("t9", outcome.itemId)
        repository.confirm(card, null)
        assertNull(recorder.bodyJson(recorder.bodies.lastIndex)["credential"])
    }

    @Test
    fun theOtherDecisionsGoToTheirOwnRoutes() = runTest {
        val (repository, recorder, card) = loaded { request ->
            if (request.method == HttpMethod.Get) json(cards(TASK_CARD)) else json("{}")
        }
        val capture = card.copy(origin = InboxOrigin.Capture("item-7", null, null, null, null, null))

        repository.reject(card)
        repository.reopen(CARD)
        repository.recompute(card)
        repository.reset(card)
        repository.decideApproval(card, approve = false)
        repository.changeType(capture, "ty2")
        repository.count()
        repository.types()
        repository.options(card, "project")

        val calls = recorder.requests.drop(2).map { "${it.method.value} ${it.url.encodedPath}" }
        assertEquals(
            listOf(
                "POST /api/proposals/$CARD/reject",
                "POST /api/proposals/$CARD/reopen",
                "POST /api/proposals/$CARD/recompute",
                "POST /api/proposals/$CARD/reset-overrides",
                "PATCH /api/approval-requests/$CARD",
                "PUT /api/inbox/items/item-7/type",
                "GET /api/inbox/cards/count",
                "GET /api/inbox-types",
                "GET /api/proposals/$CARD/options",
            ),
            calls,
        )
        assertEquals("project", recorder.requests.last().url.parameters["field"])
        assertEquals("rejected", recorder.bodyJson(6).getValue("decision").jsonPrimitive.content)
        assertEquals("ty2", recorder.bodyJson(7).getValue("typeId").jsonPrimitive.content)
        assertEquals(VERSION, recorder.bodyJson(2).getValue("ifVersion").jsonPrimitive.content)
        assertNull(recorder.bodyJson(3)["ifVersion"])
    }

    @Test
    fun aTypeNeedsTheCaptureTheCardWasMadeFrom() = runTest {
        val (repository, recorder, card) = loaded()
        val requests = recorder.requests.size

        val result = repository.changeType(card.copy(origin = null), "ty2")

        assertEquals(RepositoryResult.Failure(FailureKind.NOT_FOUND), result)
        assertEquals(requests, recorder.requests.size)
    }

    @Test
    fun aRefusedOrUnreachableServerIsAnExpectedFailure() = runTest {
        val (refusing, _, card) = loaded { request ->
            if (request.method == HttpMethod.Get) json(cards(TASK_CARD)) else json("{}", HttpStatusCode.Conflict)
        }
        val (unreadable) = fixture { json("not json") }

        assertEquals(RepositoryResult.Failure(FailureKind.REJECTED), refusing.confirm(card, null))
        val touch = InboxEdit(steps = mapOf("a" to true))
        assertEquals(RepositoryResult.Failure(FailureKind.REJECTED), refusing.edit(card, touch))
        assertEquals(RepositoryResult.Failure(FailureKind.INVALID_DATA), unreadable.stack())
        assertEquals(RepositoryResult.Failure(FailureKind.INVALID_DATA), unreadable.count())
    }
}
