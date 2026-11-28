package cz.alldots.app.data

import cz.alldots.app.core.InMemorySessionStorage
import cz.alldots.app.core.StoredSession
import io.ktor.client.engine.mock.MockEngine
import io.ktor.client.engine.mock.MockRequestHandleScope
import io.ktor.client.engine.mock.respond
import io.ktor.client.engine.mock.toByteArray
import io.ktor.client.request.HttpRequestData
import io.ktor.client.request.HttpResponseData
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
import io.ktor.http.headersOf
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject

const val PROJECTS_ID = "11111111-1111-4111-8111-111111111111"
const val COMPANIES_ID = "22222222-2222-4222-8222-222222222222"
const val FILES_ID = "33333333-3333-4333-8333-333333333333"
const val PROJECT_ITEM = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
const val COMPANY_ITEM = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"

/** A schema with Projects (status, date, company, tags in a facet bar), Companies and Files (type, file, projects). */
const val SCHEMA_JSON = """{
  "tenant": {"timezone": "Europe/Prague", "today": "2026-10-16"},
  "viewTypes": [], "agentTools": [],
  "databases": [
    {"databaseId": "$PROJECTS_ID", "key": "projects", "name": "Projekty", "searchPlaceholder": "Hledat v projektech",
     "icon": "folder", "color": "#007AFF", "overviewOrder": 1, "switcherOrder": 1, "clientVisible": true,
     "overviewHidden": false, "sensitive": false,
     "defaultSort": {"system": "createdAt", "direction": "desc"},
     "dateLabels": {"past": "Po termínu", "noDate": "Bez termínu"},
     "collectionFilter": {"type": "is_empty", "property": "systemActive"},
     "pickerFilter": {"type": "is_empty", "property": "systemActive"},
     "facetBarProperty": "tags",
     "quickFilters": [
       {"key": "active", "label": "Aktivní", "isDefault": true,
        "filter": {"type": "in", "property": "status", "value": ["inProgress", "longTerm"]}},
       {"key": "all", "label": "Vše", "isDefault": false,
        "sort": [{"property": "date", "direction": "asc"}]}
     ],
     "properties": [
       {"id": "p1", "type": "title", "filterable": false, "key": "name", "name": "Název", "owner": "user", "locked": false, "config": {}},
       {"id": "p2", "type": "select", "filterable": true, "key": "status", "name": "Stav", "owner": "user", "locked": false,
        "options": [{"key": "inProgress", "label": "Probíhá", "color": "#007AFF"}, {"key": "done", "label": "Hotovo"}], "config": {}},
       {"id": "p3", "type": "date", "filterable": true, "key": "date", "name": "Termín", "owner": "user", "locked": false, "config": {"includeTime": false}},
       {"id": "p4", "type": "relation", "filterable": true, "key": "company", "name": "Firma", "owner": "user", "locked": false,
        "config": {"targetDatabaseId": "$COMPANIES_ID", "cardinality": "one_to_many"}},
       {"id": "p5", "type": "relation", "filterable": true, "key": "tasks", "name": "Úkoly", "owner": "user", "locked": false,
        "config": {"targetDatabaseId": "tasks", "cardinality": "one_to_many"}},
       {"id": "p6", "type": "checkbox", "filterable": true, "key": "pinned", "name": "Připnuto", "owner": "user", "locked": false, "config": {}},
       {"id": "p7", "type": "multi_select", "filterable": true, "key": "tags", "name": "Štítky", "owner": "user", "locked": false,
        "options": [{"key": "a", "label": "A"}, {"key": "b", "label": "B"}], "config": {}},
       {"id": "p8", "type": "json", "filterable": false, "key": "recurrence", "name": "Opakování", "owner": "system", "locked": true, "config": {}},
       {"id": "p9", "type": "number", "filterable": false, "key": "budget", "name": "Rozpočet", "owner": "user", "locked": false, "config": {}},
       {"id": "p10", "type": "date", "filterable": false, "key": "completedAt", "name": "Dokončeno", "owner": "system", "locked": true, "config": {}}
     ]},
    {"databaseId": "$COMPANIES_ID", "key": "companies", "name": "Firmy", "searchPlaceholder": null,
     "defaultSort": {"property": "name", "direction": "asc"},
     "quickFilters": [],
     "properties": [
       {"id": "c1", "type": "title", "filterable": false, "key": "name", "name": "Název", "owner": "user", "locked": false, "config": {}}
     ]},
    {"databaseId": "$FILES_ID", "key": "files", "name": "Soubory",
     "defaultSort": {"system": "createdAt", "direction": "desc"},
     "quickFilters": [],
     "properties": [
       {"id": "f1", "type": "title", "filterable": false, "key": "name", "name": "Název", "owner": "user", "locked": false, "config": {}},
       {"id": "f2", "type": "select", "filterable": true, "key": "type", "name": "Typ", "owner": "user", "locked": false,
        "options": [{"key": "pdf", "label": "PDF"}, {"key": "jpg", "label": "JPG"}], "config": {}},
       {"id": "f3", "type": "file", "filterable": false, "key": "file", "name": "Soubor", "owner": "user", "locked": false, "config": {}},
       {"id": "f4", "type": "relation", "filterable": true, "key": "projects", "name": "Projekty", "owner": "user", "locked": false,
        "config": {"targetDatabaseId": "$PROJECTS_ID", "cardinality": "many_to_many"}}
     ]}
  ]
}"""

/** A project with a status, a company from its relations, a derived company, an inherited and a broken link. */
const val PROJECT_JSON = """{
  "id": "$PROJECT_ITEM", "databaseId": "$PROJECTS_ID",
  "properties": {"name": "Alldots iOS", "status": "inProgress", "date": "2027-01-31", "pinned": true,
                 "tags": ["a", "b"], "budget": 180000, "recurrence": {"x": 1}},
  "computed": {}, "createdAt": "2026-10-01T10:00:00Z", "updatedAt": "2026-10-16T10:00:00Z", "deletedAt": null,
  "version": "3",
  "relations": {"company": [{"id": "$COMPANY_ITEM", "databaseKey": "companies", "databaseId": "$COMPANIES_ID",
                             "title": "Novák Web", "color": "#5856D6", "metadata": {}}, {"id": "hidden-1", "hidden": true}]},
  "links": {
    "status": {"valueKind": "inherited", "sources": [{"kind": "item", "itemId": "t1", "databaseKey": "tasks", "title": "Odeslat fakturu", "propertyKey": "status"}], "brokenBy": null, "brokenAt": null},
    "date": {"valueKind": "inheritedBroken", "sources": [{"kind": "senderDomain", "domain": "novak-web.cz", "propertyKey": "date"}], "brokenBy": "agent", "brokenAt": "2026-10-10T00:00:00Z"}
  },
  "derived": {"company": {"values": [{"id": "$COMPANY_ITEM", "title": "Novák Web s.r.o.", "color": "#5856D6"}], "via": "project", "projectIds": ["$PROJECT_ITEM"]}}
}"""

/** A scripted server: answers a request of the mock engine. */
typealias Handler = suspend MockRequestHandleScope.(HttpRequestData) -> HttpResponseData

/** Records every request of a [MockEngine] and answers with [handler]. */
class Recorder(private val handler: Handler) {
    val requests = mutableListOf<HttpRequestData>()
    val bodies = mutableListOf<ByteArray>()

    val session = StoredSession("https://s.example", "tok")
    val storage = InMemorySessionStorage().also { it.save(session) }
    var rejected = 0

    val api = AuthenticatedApi(
        ApiClient(
            MockEngine { request ->
                requests += request
                bodies += request.body.toByteArray()
                handler(request)
            },
        ),
        storage,
        onSessionRejected = { rejected += 1 },
    )

    fun bodyJson(index: Int = 0): JsonObject = Json.parseToJsonElement(bodies[index].decodeToString()).jsonObject
}

fun MockRequestHandleScope.json(body: String, status: HttpStatusCode = HttpStatusCode.OK) =
    respond(body, status, headersOf(HttpHeaders.ContentType, "application/json"))

fun JsonElement.obj(): JsonObject = jsonObject
