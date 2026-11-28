package cz.alldots.app.domain

/** What a proposal does when it is approved. */
enum class InboxEntityKind { PAGE_CONTENT, DATABASE, RELATION, TRANSCRIPTION, JOURNAL_ENTRY, OTHER }

/**
 * One step of a multi-step proposal. A step is [primary] or a secondary one that the person may switch off
 * ([optional] or not, [enabled] says whether it is carried out); [databaseKey] names the database a `create` step
 * writes to.
 */
data class InboxStep(
    val ref: String,
    val operation: String,
    val primary: Boolean,
    val databaseKey: String?,
    val enabled: Boolean,
    val optional: Boolean,
    val properties: Map<String, InboxValue>,
    val relations: Map<String, List<String>>,
)

/**
 * The effective proposal of a card (the stored `proposal`): its [target] (a database, a page or an item id by
 * [entityKind]), the values it writes and the item ids it links. A single-step proposal has no [steps]; its values are
 * the ones of the one step `primary`.
 */
data class InboxEnvelope(
    val entityKind: InboxEntityKind,
    val target: String,
    val properties: Map<String, InboxValue>,
    val relations: Map<String, List<String>>,
    val steps: List<InboxStep> = emptyList(),
) {
    /** The ref the editor writes the card's own values under. */
    val primaryRef: String get() = steps.firstOrNull { it.primary }?.ref ?: SINGLE_STEP_REF

    companion object {
        /** The ref a single-step proposal answers to. */
        const val SINGLE_STEP_REF = "primary"
    }
}
