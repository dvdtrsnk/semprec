package cz.semprec.app.domain

/**
 * What the person changed on a card, in the shape the server takes (`PATCH /api/proposals/:id/values`): values by
 * step ref and key (`null` clears one), the full replacement list of a relation, and the steps to switch on or off.
 */
data class InboxEdit(
    val values: Map<String, Map<String, InboxValue?>> = emptyMap(),
    val relations: Map<String, Map<String, List<String>>> = emptyMap(),
    val steps: Map<String, Boolean> = emptyMap(),
) {
    val isEmpty: Boolean get() = values.isEmpty() && relations.isEmpty() && steps.isEmpty()

    operator fun plus(other: InboxEdit): InboxEdit = InboxEdit(
        values = merge(values, other.values),
        relations = merge(relations, other.relations),
        steps = steps + other.steps,
    )

    private fun <V> merge(a: Map<String, Map<String, V>>, b: Map<String, Map<String, V>>): Map<String, Map<String, V>> =
        (a.keys + b.keys).associateWith { (a[it].orEmpty()) + (b[it].orEmpty()) }
}

/** A replacement of the whole proposal of a card, which changes where it writes or whom it links. */
sealed interface InboxRevision {
    /** The text of a page-content card goes to another page; the rest of the proposal stays. */
    data class Page(val target: String, val properties: Map<String, InboxValue>) : InboxRevision

    /** A transcript is linked to the event [target] (an item id, or `series@date` for a virtual occurrence). */
    data class LinkEvent(val target: String) : InboxRevision

    /** The speaker [speaker] of a transcript is the person [personId]. */
    data class LinkSpeaker(val personId: String, val speaker: String) : InboxRevision
}

/** What the person picks or types into one field; the card decides how it is written. */
sealed interface InboxInput {
    data class Text(val text: String) : InboxInput
    data class Flag(val on: Boolean) : InboxInput

    /** The date part of a date or date-and-time field. */
    data class Date(val date: String) : InboxInput

    /** The time part of a date-and-time field. */
    data class Time(val time: String) : InboxInput

    /** One option of a select, a segmented control or a colour, by its key; `null` is the "none" choice. */
    data class Pick(val choice: InboxChoice) : InboxInput

    /** The whole selection of a multi-value field. */
    data class Many(val ids: List<String>) : InboxInput
}

/** How an input is written: as values and relations of the proposal, or as a new proposal of the card. */
sealed interface InboxChange {
    data class Edit(val edit: InboxEdit) : InboxChange
    data class Revise(val revision: InboxRevision) : InboxChange

    /** The input cannot change this field (it is read-only, or the card has no place for it). */
    data object None : InboxChange
}

/**
 * Turns an [input] into the field [field] of this card into the change the server takes. A select of items writes the
 * relation list when the destination has a relation of that key, the id as the card's own value when it has not; the
 * page a text goes to, the time of a date-and-time field and the follow-up task are written the way the server reads
 * them.
 */
fun InboxCard.change(field: InboxField, input: InboxInput): InboxChange = when (field.key) {
    InboxFieldKeys.FOLLOWUP_TASK, InboxFieldKeys.FOLLOW_DATE -> followUpChange(field, input)
    InboxFieldKeys.PAGE -> (input as? InboxInput.Pick)?.let { pageRevision(it.choice) } ?: InboxChange.None
    else -> ownChange(field, input)
}

private fun InboxCard.ownChange(field: InboxField, input: InboxInput): InboxChange {
    val ref = envelope?.primaryRef ?: InboxEnvelope.SINGLE_STEP_REF
    val key = propertyKey(field.key)
    val edit = when (input) {
        is InboxInput.Text -> set(ref, key, InboxValue.Text(input.text))
        is InboxInput.Flag -> set(ref, key, InboxValue.Flag(input.on))
        is InboxInput.Date -> set(ref, key, InboxValue.Text(input.date))
        is InboxInput.Time -> set(ref, InboxFieldKeys.TIME_FROM, InboxValue.Text(input.time))
        is InboxInput.Pick -> pick(ref, key, field, input.choice)
        is InboxInput.Many -> pickMany(ref, key, input.ids)
    }
    return InboxChange.Edit(edit)
}

private fun InboxCard.followUpChange(field: InboxField, input: InboxInput): InboxChange {
    val step = followUpStep() ?: return InboxChange.None
    return when {
        field.key == InboxFieldKeys.FOLLOWUP_TASK && input is InboxInput.Flag ->
            InboxChange.Edit(InboxEdit(steps = mapOf(step.ref to input.on)))
        field.key == InboxFieldKeys.FOLLOW_DATE && input is InboxInput.Date ->
            InboxChange.Edit(set(step.ref, InboxFieldKeys.DATE, InboxValue.Text(input.date)))
        else -> InboxChange.None
    }
}

private fun set(ref: String, key: String, value: InboxValue?) = InboxEdit(values = mapOf(ref to mapOf(key to value)))

private fun InboxCard.isRelation(key: String): Boolean =
    properties[key]?.type == InboxPropertyType.RELATION || ownRelations().containsKey(key)

/**
 * An option of a select: the event of a recording (which also says whether there is none), the language (`auto` is no
 * language), an item (a relation list or the id) when the field has a source, else the option key.
 */
private fun InboxCard.pick(ref: String, key: String, field: InboxField, choice: InboxChoice): InboxEdit = when {
    key == InboxFieldKeys.EVENT_ID -> InboxEdit(
        values = mapOf(
            ref to mapOf(
                InboxFieldKeys.EVENT_ID to choice.id?.let { InboxValue.Text(it) },
                InboxFieldKeys.NO_EVENT to InboxValue.Flag(choice.id == null),
            ),
        ),
    )
    key == InboxFieldKeys.LANGUAGE ->
        set(ref, key, choice.id?.takeIf { it != AUTO_LANGUAGE }?.let { InboxValue.Text(it) })
    field.optionsSource != null && isRelation(key) ->
        InboxEdit(relations = mapOf(ref to mapOf(key to listOfNotNull(choice.id))))
    else -> set(ref, key, choice.id?.let { InboxValue.Text(it) })
}

private fun InboxCard.pickMany(ref: String, key: String, ids: List<String>): InboxEdit =
    if (isRelation(key)) {
        InboxEdit(relations = mapOf(ref to mapOf(key to ids)))
    } else {
        set(ref, key, InboxValue.Items(ids))
    }

private fun InboxCard.pageRevision(choice: InboxChoice): InboxChange {
    val envelope = envelope
    val target = choice.id
    return if (envelope == null || target == null || envelope.entityKind != InboxEntityKind.PAGE_CONTENT) {
        InboxChange.None
    } else {
        InboxChange.Revise(InboxRevision.Page(target, envelope.properties))
    }
}
