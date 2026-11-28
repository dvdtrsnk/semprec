package cz.semprec.app.data

import cz.semprec.app.core.StoredSession
import io.ktor.http.HttpMethod
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/** The status of an Inbox entry of the diary that waits on the device; the server never sends it. */
internal const val WAITING_INBOX_STATUS = "waiting"

private const val INBOX_TYPES_PATH = "/api/inbox-types"
private val DAY_PERIOD_PATH = Regex("^/api/journal/periods/day/(\\d{4}-\\d{2}-\\d{2})$")

/**
 * Shows the Inbox captures that wait in the outbox ([CaptureOutbox]) in the diary's day answer
 * (`GET /api/journal/periods/day/<day>`), so a capture is listed before the server has it. [apply] is pure;
 * [CaptureViews] gathers what it needs.
 */
internal object CaptureProjection {
    /**
     * [answer] to [read] with every capture of [captures] made for the day [read] asks for, and whose id is not among
     * the answer's Inbox entries, listed after those entries in the order of [captures]. Each is an entry with the
     * capture's id, time and text, the emoji [emojis] names for its type, the name of its file and the status
     * [WAITING_INBOX_STATUS]. Any other read, an answer that is not a JSON object and a day without such a capture are
     * returned unchanged.
     */
    fun apply(
        read: ApiRequest,
        answer: ApiResponse,
        captures: List<KeptCapture>,
        emojis: Map<String, String>,
    ): ApiResponse {
        val day = dayOf(read)
        val success = answer as? ApiResponse.Success
        val root = success?.let { parseJsonObject(it.body) }
        val listed = (root?.get("inbox") as? JsonArray).orEmpty()
        val ids = listed.mapNotNull { it.idOf() }.toSet()
        val waiting = captures.filter { it.day == day && it.id !in ids }
        return if (success == null || root == null || waiting.isEmpty()) {
            answer
        } else {
            val inbox = JsonArray(listed + waiting.map { it.entry(emojis) })
            success.copy(body = JsonObject(root + ("inbox" to inbox)).toString())
        }
    }

    /** The day of the diary [read] asks for, `YYYY-MM-DD`, or `null` for any other request. */
    fun dayOf(read: ApiRequest): String? =
        if (read.method == HttpMethod.Get) DAY_PERIOD_PATH.find(read.path)?.groupValues?.get(1) else null

    private fun KeptCapture.entry(emojis: Map<String, String>): JsonObject = buildJsonObject {
        put("id", id)
        put("time", time)
        put("text", text)
        put("type", typeId?.let(emojis::get)?.let { emoji -> buildJsonObject { put("emoji", emoji) } } ?: JsonNull)
        put("status", WAITING_INBOX_STATUS)
        put("attachments", buildJsonArray { file?.let { add(buildJsonObject { put("name", it.name) }) } })
    }
}

/**
 * Applies the outbox of the person a read is made with to the diary's day answers ([CaptureProjection]), with the
 * emojis of the types from the kept `GET /api/inbox-types` of the account.
 */
internal class CaptureViews(private val store: OfflineStore, private val captures: CaptureOutbox) {
    suspend fun project(
        session: StoredSession,
        account: String,
        read: ApiRequest,
        answer: ApiResponse,
    ): ApiResponse {
        val projected = CaptureProjection.dayOf(read) != null && answer is ApiResponse.Success
        val waiting = if (projected) captures.waitingOf(session) else emptyList()
        val emojis = if (waiting.any { it.typeId != null }) emojis(account) else emptyMap()
        return if (waiting.isEmpty()) answer else CaptureProjection.apply(read, answer, waiting, emojis)
    }

    /** The emoji of each Inbox type the kept `GET /api/inbox-types` names, by type id; none when it is not kept. */
    private suspend fun emojis(account: String): Map<String, String> {
        val kept = store.answers.answer(account, ApiRequest(HttpMethod.Get, INBOX_TYPES_PATH).key())
        val types = kept?.let { decodeCaptureOrNull { ApiJson.decodeFromString(InboxTypesDto.serializer(), it.body) } }
        return types?.types.orEmpty().filter { it.emoji.isNotBlank() }.associate { it.id to it.emoji }
    }
}
