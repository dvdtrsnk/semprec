package cz.semprec.app.data

import cz.semprec.app.core.FailureKind
import cz.semprec.app.domain.CalendarDay
import io.ktor.http.HttpMethod
import kotlinx.serialization.SerializationException
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.put

private const val OK_STATUS = 200
private const val NOT_FOUND_STATUS = 404
private const val DATABASE_SEGMENT = 3
private const val ITEM_SEGMENT = 3
private const val RELATION_KEY_SEGMENT = 5
private const val RELATION_TARGET_SEGMENT = 6
private const val SERIES_SEGMENT = 4
private const val OCCURRENCE_DATE_SEGMENT = 6
private const val INVITATION_SEGMENT = 4
private const val EVENTS_KEY = "events"
private const val TASKS_KEY = "tasks"
private const val STATUS_DONE = "done"
private const val STATUS_WONT_DO = "wontDo"
private const val STATUS_NOT_DONE = "notDone"

/** The timeline and agenda fields an item change sets, by the item property that holds each. */
private val ENTRY_FIELDS = mapOf(
    "name" to "title",
    "date" to "date",
    "endDate" to "endDate",
    "timeFrom" to "timeFrom",
    "timeTo" to "timeTo",
    "status" to "status",
    "place" to "place",
)

/** The item properties whose change moves or ends the reminder of an item. */
private val REMINDER_INPUTS = setOf("date", "timeFrom", "alertMinutes", "travelMinutes")

/** A queued write as a projection reads it: its route, its request with the server ids known so far, its new id. */
internal class PendingWrite(val route: QueuedRoute, val request: ApiRequest, val newId: String?, val queuedAt: String)

/**
 * What a projection needs besides the answer: the ids of the databases by key (from the kept `GET /api/schema`), the
 * device's day, the title of each related item a write names, and the item each queued create made up, by its id.
 */
internal class ProjectionContext(
    val databases: Map<String, String>,
    val today: CalendarDay,
    val titles: Map<String, String>,
    val created: Map<String, JsonObject>,
)

/**
 * Shows the writes that wait in the queue in the answers of the offline set, so a screen shows what the person did
 * before the server has it (docs/adr/2026-11-23-mobile-writes-wait-in-an-ordered-queue-without-a-connection.md).
 * [apply] is pure; [QueuedViews] gathers what it needs.
 */
internal object QueuedWriteProjection {
    /**
     * [answer] to [read] with [writes] applied in queue order. With no write or an answer that is not JSON it is
     * returned unchanged; an item a queued create made is answered as the device made it, and an item a queued delete
     * removes answers `404`.
     */
    fun apply(
        read: ApiRequest,
        answer: ApiResponse,
        writes: List<PendingWrite>,
        context: ProjectionContext
    ): ApiResponse {
        if (writes.isEmpty()) return answer
        val itemRead = itemIdOf(read)
        val made = itemRead?.let(context.created::get)
        val base = if (made != null) ApiResponse.Success(OK_STATUS, made.toString()) else answer
        val removed = itemRead != null &&
            writes.any { it.route == QueuedRoute.DELETE_ITEM && it.targetId() == itemRead }
        val success = base as? ApiResponse.Success
        val root = success?.let { parseJsonObject(it.body) }
        return when {
            removed -> ApiResponse.Failure(FailureKind.NOT_FOUND, NOT_FOUND_STATUS, "")
            success == null || root == null -> base
            else -> {
                val projected = writes.fold<PendingWrite, JsonElement>(root) { element, write ->
                    applyOne(read, element, write, context)
                }
                if (projected == root) success else success.copy(body = projected.toString())
            }
        }
    }

    private fun applyOne(read: ApiRequest, element: JsonElement, write: PendingWrite, context: ProjectionContext) =
        when (write.route) {
            QueuedRoute.PATCH_ITEM -> patched(element, write, context)
            QueuedRoute.DELETE_ITEM -> deleted(element, write.targetId())
            QueuedRoute.CREATE_ITEM -> created(read, element, write, context)
            QueuedRoute.ADD_RELATION, QueuedRoute.REMOVE_RELATION, QueuedRoute.SET_RELATION ->
                related(element, write, context)
            QueuedRoute.OCCURRENCE -> occurrence(element, write)
            QueuedRoute.INVITATION_ANSWER -> answered(element, write)
            QueuedRoute.VALUE_LINK,
            QueuedRoute.SET_TASK_RECURRENCE,
            QueuedRoute.CLEAR_TASK_RECURRENCE,
            QueuedRoute.HOST_EVENT,
            QueuedRoute.INBOX_CAPTURE,
            QueuedRoute.PERIOD_PAGE,
            -> element
        }

    private fun patched(element: JsonElement, write: PendingWrite, context: ProjectionContext): JsonElement {
        val id = write.targetId()
        val change = parseJsonObject(write.request.body)?.objectAt("properties") ?: return element
        val tasks = context.databases[TASKS_KEY]
        return element.rewritten(
            drop = { it.isReminderOf(id) && movesReminder(change) },
            change = { node ->
                when {
                    node.isItem(id) -> {
                        val derived = derived(change, node.text("databaseId") == tasks, context.today)
                        val properties = (node.objectAt("properties") ?: emptyMap()) + change + derived
                        JsonObject(node + ("properties" to JsonObject(properties)))
                    }
                    node.isEntry(id) -> JsonObject(
                        node + ENTRY_FIELDS.mapNotNull { (property, field) -> change[property]?.let { field to it } },
                    )
                    node.isReminderOf(id) -> change["name"]?.let { JsonObject(node + ("title" to it)) } ?: node
                    else -> node
                }
            },
        )
    }

    private fun deleted(element: JsonElement, id: String): JsonElement = element.rewritten(
        drop = { node -> node.text("id") == id || node.text("seriesId") == id || node.isReminderOf(id) },
    )

    private fun created(
        read: ApiRequest,
        element: JsonElement,
        write: PendingWrite,
        context: ProjectionContext,
    ): JsonElement {
        val made = write.newId?.let(context.created::get)
        val database = segment(write.request.path, DATABASE_SEGMENT)
        val root = element as? JsonObject
        val kind = when (database) {
            context.databases[EVENTS_KEY] -> "event"
            context.databases[TASKS_KEY] -> "task"
            else -> null
        }
        val query = parseJsonObject(read.body)
        return when {
            made == null || root == null -> element
            read.isFirstQueryPage(database) && ItemFilterMatch.matches(query?.get("filter"), made, context.today) ->
                root.withItem(made, query?.get("sort"))
            kind != null && read.holdsDay(made.objectAt("properties")?.text("date"), root) ->
                root.withEntry(entryOf(made, kind))
            else -> root
        }
    }

    private fun related(element: JsonElement, write: PendingWrite, context: ProjectionContext): JsonElement {
        val path = write.request.path
        val id = write.targetId()
        val key = segment(path, RELATION_KEY_SEGMENT) ?: return element
        val target = segment(path, RELATION_TARGET_SEGMENT)
        val body = parseJsonObject(write.request.body)
        return element.rewritten(change = { node ->
            val relations = node.objectAt("relations")
            if (!node.isItem(id) || relations == null) return@rewritten node
            val before = (relations[key] as? JsonArray) ?: emptyList()
            val after = when (write.route) {
                QueuedRoute.ADD_RELATION ->
                    before.filterNot { it.idOf() == target } + listOfNotNull(target?.let { targetOf(it, context) })
                QueuedRoute.REMOVE_RELATION -> before.filterNot { it.idOf() == target }
                else -> setTargets(body).map { targetOf(it, context) }
            }
            JsonObject(node + ("relations" to JsonObject(relations + (key to JsonArray(after)))))
        })
    }

    private fun occurrence(element: JsonElement, write: PendingWrite): JsonElement {
        val series = segment(write.request.path, SERIES_SEGMENT)
        val day = segment(write.request.path, OCCURRENCE_DATE_SEGMENT)
        val made = write.newId ?: return element
        return element.rewritten(change = { node ->
            val stored = node.text("kind") != null && node.text("seriesId") == series &&
                node.text("occurrenceDate") == day
            val storedFields = mapOf("id" to JsonPrimitive(made), "readOnly" to JsonPrimitive(false))
            if (stored) JsonObject(node + storedFields) else node
        })
    }

    private fun answered(element: JsonElement, write: PendingWrite): JsonElement {
        val id = segment(write.request.path, INVITATION_SEGMENT)
        val response = parseJsonObject(write.request.body)?.get("response") as? JsonPrimitive ?: return element
        return element.rewritten(change = { node ->
            val properties = node.objectAt("properties")
            if (node.text("id") == id && properties?.containsKey("status") == true) {
                JsonObject(node + ("properties" to JsonObject(properties + ("status" to response))))
            } else {
                node
            }
        })
    }

    /** What the server derives from a task's change: the day it was completed, the day it counts for. */
    private fun derived(change: JsonObject, isTask: Boolean, today: CalendarDay): Map<String, JsonElement> = buildMap {
        if (!isTask) return@buildMap
        val status = (change["status"] as? JsonPrimitive)?.takeIf { it.isString }?.content
        if (status != null && !change.containsKey("completedOn")) {
            put("completedOn", if (status == STATUS_DONE) JsonPrimitive(today.toString()) else JsonNull)
        }
        change["date"]?.let { put("effectiveDate", it) }
    }

    private fun movesReminder(change: JsonObject): Boolean {
        val status = (change["status"] as? JsonPrimitive)?.takeIf { it.isString }?.content
        return change.keys.any { it in REMINDER_INPUTS } || status == STATUS_DONE || status == STATUS_WONT_DO
    }
}

/** [this] tree with every object passed through [change] (its children first) and the array elements [drop] names left out. */
private fun JsonElement.rewritten(
    drop: (JsonObject) -> Boolean = { false },
    change: (JsonObject) -> JsonObject = { it },
): JsonElement = when (this) {
    is JsonObject -> change(JsonObject(mapValues { (_, value) -> value.rewritten(drop, change) }))
    is JsonArray -> JsonArray(filterNot { it is JsonObject && drop(it) }.map { it.rewritten(drop, change) })
    else -> this
}

/** The id a write of an item names: the item of its path. */
private fun PendingWrite.targetId(): String = segment(request.path, ITEM_SEGMENT).orEmpty()

/** The item id of a `GET /api/items/:id`, or `null` for any other read. */
private fun itemIdOf(read: ApiRequest): String? =
    if (read.method == HttpMethod.Get && QueuedRoute.of(HttpMethod.Patch, read.path) == QueuedRoute.PATCH_ITEM) {
        segment(read.path, ITEM_SEGMENT)
    } else {
        null
    }

private fun JsonObject.isItem(id: String) = text("id") == id && this["properties"] is JsonObject

private fun JsonObject.isEntry(id: String) = text("id") == id && text("kind") != null && this["properties"] == null

private fun JsonObject.isReminderOf(id: String) = text("itemId") == id && containsKey("fireAt")

internal fun JsonObject.objectAt(key: String): JsonObject? = this[key] as? JsonObject

internal fun JsonElement.idOf(): String? = (this as? JsonObject)?.text("id")

/** [text] as a JSON object, or `null` when it is none or not JSON. */
internal fun parseJsonObject(text: String?): JsonObject? = text?.let {
    try {
        ApiJson.parseToJsonElement(it) as? JsonObject
    } catch (_: SerializationException) {
        null
    }
}

/**
 * Applies the queue of an account to the answers its reads get ([QueuedWriteProjection]), gathering what that needs
 * from the store: the database ids of the kept `GET /api/schema`, the kept objects of the items the writes relate to,
 * the item each queued create made up, and [today].
 */
internal class QueuedViews(private val store: OfflineStore, private val today: () -> String) {
    /** [answer] to [read] with the writes of [queued] applied; unchanged when nothing is queued. */
    suspend fun project(account: String, read: ApiRequest, answer: ApiResponse, queued: QueueState?): ApiResponse {
        val writes = queued?.writes.orEmpty().mapNotNull { it.pending(queued?.ids.orEmpty()) }
        val day = CalendarDay.parse(today())
        if (writes.isEmpty() || day == null) return answer
        val related = writes.flatMap(::relatedIds).distinct().mapNotNull { id ->
            store.answers.newestObject(account, id)?.let { id to it }
        }.toMap()
        val databases = databases(account)
        val created = writes.mapNotNull { write ->
            val made = write.newId?.takeIf { write.route == QueuedRoute.CREATE_ITEM } ?: return@mapNotNull null
            val item =
                parseJsonObject(QueuedAnswers.answer(write.route, write.request, made, write.queuedAt, related).body)
            val isTask = segment(write.request.path, DATABASE_SEGMENT) == databases[TASKS_KEY]
            item?.let { made to if (isTask) it.withTaskDefaults() else it }
        }.toMap()
        val titles = related.mapNotNull { (id, kept) -> kept.titleOf()?.let { id to it } }.toMap()
        val context = ProjectionContext(databases, day, titles, created)
        return QueuedWriteProjection.apply(read, answer, writes, context)
    }

    /** The database ids of the kept `GET /api/schema`, by canonical key; none when it is not kept. */
    private suspend fun databases(account: String): Map<String, String> {
        val schema = store.answers.answer(account, ApiRequest(HttpMethod.Get, SCHEMA_PATH).key())
        val databases = schema?.let { parseJsonObject(it.body)?.get("databases") as? JsonArray } ?: emptyList()
        return databases.mapNotNull { element ->
            val database = element as? JsonObject
            val key = database?.text("key")
            val id = database?.text("databaseId")
            if (key != null && id != null) key to id else null
        }.toMap()
    }

    /** The items a write names besides the one it writes: the targets of its relations. */
    private fun relatedIds(write: PendingWrite): List<String> = when (write.route) {
        QueuedRoute.ADD_RELATION -> listOfNotNull(segment(write.request.path, RELATION_TARGET_SEGMENT))
        QueuedRoute.SET_RELATION -> setTargets(parseJsonObject(write.request.body))
        QueuedRoute.CREATE_ITEM -> QueuedAnswers.lookups(write.route, write.request)
        else -> emptyList()
    }

    /**
     * [this] task as the server stores a new one: open unless the create says otherwise, and counting for the day it has
     * (the server would move that day to a host event's; a new task has none).
     */
    private fun JsonObject.withTaskDefaults(): JsonObject {
        val properties = objectAt("properties") ?: JsonObject(emptyMap())
        val defaults = buildMap {
            if (!properties.containsKey("status")) put("status", JsonPrimitive(STATUS_NOT_DONE))
            properties["date"]?.takeIf { !properties.containsKey("effectiveDate") }?.let { put("effectiveDate", it) }
        }
        return if (defaults.isEmpty()) this else JsonObject(this + ("properties" to JsonObject(properties + defaults)))
    }

    /** [this] queued write as a projection reads it, with every server id of [ids] in place of the id made for it. */
    private fun QueuedWrite.pending(ids: Map<String, String>): PendingWrite? {
        val request = toRequest().resolved(ids)
        val route = QueuedRoute.of(request.method, request.path) ?: return null
        return PendingWrite(route, request, newId, queuedAt)
    }
}

private const val SCHEMA_PATH = "/api/schema"
