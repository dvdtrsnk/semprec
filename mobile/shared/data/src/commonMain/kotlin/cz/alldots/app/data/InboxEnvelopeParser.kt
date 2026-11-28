package cz.alldots.app.data

import cz.alldots.app.domain.InboxEntityKind
import cz.alldots.app.domain.InboxEnvelope
import cz.alldots.app.domain.InboxStep
import cz.alldots.app.domain.InboxValue
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull

private val ENTITY_KINDS = mapOf(
    "pageContent" to InboxEntityKind.PAGE_CONTENT,
    "database" to InboxEntityKind.DATABASE,
    "relation" to InboxEntityKind.RELATION,
    "transcription" to InboxEntityKind.TRANSCRIPTION,
    "journalEntry" to InboxEntityKind.JOURNAL_ENTRY,
)

/**
 * The proposal of a card, as the server stores it. Anything that is not an object with a target is no proposal (a card
 * that is not computed yet has none), and what a value is that this app cannot show (a list of blocks) is left out.
 */
internal fun JsonElement?.toEnvelope(): InboxEnvelope? {
    val root = this as? JsonObject
    val target = root?.text("target")
    return if (root == null || target == null) {
        null
    } else {
        InboxEnvelope(
            entityKind = ENTITY_KINDS[root.text("entityKind")] ?: InboxEntityKind.OTHER,
            target = target,
            properties = (root["properties"] as? JsonObject).toValues(),
            relations = (root["relations"] as? JsonObject).toRelations(),
            steps = (root["operations"] as? JsonArray)?.mapNotNull { it.toStep() }.orEmpty(),
        )
    }
}

private fun JsonElement.toStep(): InboxStep? {
    val step = this as? JsonObject
    val ref = step?.text("ref")
    return if (step == null || ref == null) {
        null
    } else {
        InboxStep(
            ref = ref,
            operation = step.text("op").orEmpty(),
            primary = step.text("role") == "primary",
            databaseKey = step.text("databaseKey"),
            enabled = (step["enabled"] as? JsonPrimitive)?.booleanOrNull ?: true,
            optional = (step["optional"] as? JsonPrimitive)?.booleanOrNull ?: false,
            properties = (step["properties"] as? JsonObject).toValues(),
            relations = (step["relations"] as? JsonObject).toRelations(),
        )
    }
}

/** The values of a property map: texts, numbers (as text), switches, and a requested new select option. */
internal fun JsonObject?.toValues(): Map<String, InboxValue> {
    val values = mutableMapOf<String, InboxValue>()
    this?.forEach { (key, element) -> element.toValue()?.let { values[key] = it } }
    return values
}

private fun JsonElement.toValue(): InboxValue? = when (this) {
    is JsonPrimitive -> booleanOrNull?.takeIf { !isString }?.let { InboxValue.Flag(it) }
        ?: contentOrNull?.let { InboxValue.Text(it) }
    is JsonObject -> text("newOption")?.let { InboxValue.NewOption(it) }
    is JsonArray -> toItems()
}

/** A list of ids the editor of a multi-value field holds; any other list is not a value. */
private fun JsonArray.toItems(): InboxValue? {
    val ids = mapNotNull { (it as? JsonPrimitive)?.takeIf { primitive -> primitive.isString }?.contentOrNull }
    return if (ids.size == size && ids.isNotEmpty()) InboxValue.Items(ids) else null
}

/** The item ids of each relation list; a target that is the ref of another step is no item yet and is left out. */
internal fun JsonObject?.toRelations(): Map<String, List<String>> =
    this?.mapValues { (_, list) ->
        (list as? JsonArray)?.mapNotNull { (it as? JsonPrimitive)?.takeIf { p -> p.isString }?.contentOrNull }.orEmpty()
    }.orEmpty()
