package cz.semprec.app.data

import cz.semprec.app.domain.InboxApproval
import cz.semprec.app.domain.InboxCard
import cz.semprec.app.domain.InboxCardStatus
import cz.semprec.app.domain.InboxEdit
import cz.semprec.app.domain.InboxOutcome
import cz.semprec.app.domain.InboxRevision
import cz.semprec.app.domain.InboxRisk
import cz.semprec.app.domain.InboxValue
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/** The bodies of the writes on a card (`PATCH /values`, `POST /revise`, the decisions) and the answers read back. */
internal object InboxWire {
    private const val PROPERTY_KEY = "propertyKey"
    private const val EVENT_PROPERTY = "event"
    private const val SPEAKERS_PROPERTY = "speakers"
    private const val CREDENTIAL_TYPE = "api_key"

    /** A body that only carries the version the person read the card at. */
    fun version(version: String?): JsonObject = buildJsonObject { version?.let { put("ifVersion", it) } }

    fun edit(edit: InboxEdit, version: String?): JsonObject = buildJsonObject {
        if (edit.values.isNotEmpty()) {
            put(
                "set",
                JsonObject(edit.values.mapValues { (_, values) -> JsonObject(values.mapValues { it.value.json() }) }),
            )
        }
        if (edit.relations.isNotEmpty()) {
            put(
                "relations",
                JsonObject(
                    edit.relations.mapValues { (_, lists) ->
                        JsonObject(lists.mapValues { JsonArray(it.value.map(::JsonPrimitive)) })
                    },
                ),
            )
        }
        if (edit.steps.isNotEmpty()) {
            put("steps", JsonObject(edit.steps.mapValues { buildJsonObject { put("enabled", it.value) } }))
        }
        version?.let { put("ifVersion", it) }
    }

    fun revision(card: InboxCard, revision: InboxRevision): JsonObject = buildJsonObject {
        when (revision) {
            is InboxRevision.Page -> {
                put("entityKind", "pageContent")
                put("target", revision.target)
                put("properties", JsonObject(revision.properties.mapValues { it.value.json() }))
            }
            is InboxRevision.LinkEvent -> {
                put("entityKind", "relation")
                put("target", revision.target)
                put("properties", buildJsonObject { put(PROPERTY_KEY, EVENT_PROPERTY) })
            }
            is InboxRevision.LinkSpeaker -> {
                put("entityKind", "relation")
                put("target", revision.personId)
                put(
                    "properties",
                    buildJsonObject {
                        put(PROPERTY_KEY, SPEAKERS_PROPERTY)
                        put("metadata", buildJsonObject { put("speaker", revision.speaker) })
                    },
                )
            }
        }
        card.version?.let { put("ifVersion", it) }
    }

    fun confirm(version: String?, secret: String?): JsonObject = buildJsonObject {
        version?.let { put("ifVersion", it) }
        if (secret != null) {
            put(
                "credential",
                buildJsonObject {
                    put("credentialType", CREDENTIAL_TYPE)
                    put("plaintext", secret)
                },
            )
        }
    }

    fun decision(approve: Boolean): JsonObject =
        buildJsonObject { put("decision", if (approve) "approved" else "rejected") }

    fun changeType(typeId: String, version: String?): JsonObject = buildJsonObject {
        put("typeId", typeId)
        version?.let { put("ifVersion", it) }
    }

    private fun InboxValue?.json(): JsonElement = when (this) {
        null -> JsonNull
        is InboxValue.Text -> JsonPrimitive(text)
        is InboxValue.Flag -> JsonPrimitive(on)
        is InboxValue.NewOption -> buildJsonObject { put("newOption", label) }
        is InboxValue.Items -> JsonArray(ids.map(::JsonPrimitive))
    }
}

/**
 * The card after a write: the answer's item holds its status, its effective proposal and the person's own values
 * (`userOverrides`, with the keys that differ from Semp's in `userEditedKeys`), which the card list does not carry.
 */
internal fun InboxCard.after(item: InboxItemDto): InboxCard {
    val status = when (item.properties.text("status")) {
        "proposed" -> InboxCardStatus.PROPOSED
        "computing" -> InboxCardStatus.COMPUTING
        "computeFailed" -> InboxCardStatus.COMPUTE_FAILED
        "needsClarification" -> InboxCardStatus.NEEDS_CLARIFICATION
        "invalid" -> InboxCardStatus.INVALID
        else -> status
    }
    val overrides = item.properties["userOverrides"] as? JsonObject
    return copy(
        status = status,
        version = item.updatedAt.ifEmpty { version },
        envelope = item.properties["proposal"].toEnvelope() ?: envelope,
        invalid = if (status == InboxCardStatus.INVALID) invalid else null,
        userValues = overrides.toUserValues(),
        editedKeys = (item.properties["userEditedKeys"] as? JsonArray).orEmpty()
            .mapNotNull { (it as? JsonPrimitive)?.takeIf { primitive -> primitive.isString }?.content }
            .toSet(),
    )
}

/** The values the person set by step: `ref.key` to value, leaving out the relation lists and step switches. */
private fun JsonObject?.toUserValues(): Map<String, InboxValue> {
    val values = mutableMapOf<String, InboxValue>()
    this?.forEach { (ref, step) ->
        (step as? JsonObject).toValues().forEach { (key, value) ->
            if (key != "relations" && key != "enabled") values["$ref.$key"] = value
        }
    }
    return values
}

/** The outcome of a confirmation: the primary item it wrote, or the first one. */
internal fun InboxItemDto.outcome(): InboxOutcome? =
    (results.firstOrNull { it.role == "primary" } ?: results.firstOrNull())?.let {
        InboxOutcome(it.label, it.databaseKey, it.itemId.ifEmpty { null })
    }

private val RISKS = mapOf(
    "irreversible" to InboxRisk.IRREVERSIBLE,
    "outbound" to InboxRisk.OUTBOUND,
    "breaksLink" to InboxRisk.BREAKS_LINK,
    "write" to InboxRisk.WRITE,
)

/** What an approval request asks for: the operation (or the tool of an MCP server), the risk and the reason. */
internal fun InboxApprovalDto.toApproval(): InboxApproval {
    val summary = safeSummary
    val operation = summary?.operationName ?: summary?.mcpToolName ?: summary?.toolName ?: toolName
    return InboxApproval(RISKS[riskLevel] ?: InboxRisk.WRITE, operation, reason)
}
