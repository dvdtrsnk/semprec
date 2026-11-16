package cz.semprec.app.domain

/** The properties of the card's own destination: the one step of a single-step proposal, else the primary step. */
internal fun InboxCard.ownProperties(): Map<String, InboxValue> {
    val envelope = envelope ?: return emptyMap()
    return envelope.steps.firstOrNull { it.primary }?.properties ?: envelope.properties
}

/** The item ids the card's own destination links, by relation property key. */
internal fun InboxCard.ownRelations(): Map<String, List<String>> {
    val envelope = envelope ?: return emptyMap()
    return envelope.steps.firstOrNull { it.primary }?.relations ?: envelope.relations
}

/** The secondary step that creates the follow-up task of the card, if the proposal has one. */
internal fun InboxCard.followUpStep(): InboxStep? =
    envelope?.steps?.firstOrNull { !it.primary && it.databaseKey == InboxFieldKeys.TASKS_DATABASE }

/** The key the value of the editor field [key] has in the proposal of this card. */
internal fun InboxCard.propertyKey(key: String): String =
    if (envelope?.entityKind == InboxEntityKind.JOURNAL_ENTRY && key == InboxFieldKeys.DAY) InboxFieldKeys.DATE else key

/** The key under which the person's own value of [key] is remembered. */
internal fun InboxCard.userKey(key: String): String = "${envelope?.primaryRef ?: InboxEnvelope.SINGLE_STEP_REF}.$key"

/**
 * The value the editor shows for the field [key]: the proposal's own value, else the value the person set for a field
 * that is no property of the destination, else what the proposal implies for it.
 */
fun InboxCard.valueOf(key: String): InboxValue? {
    val actual = propertyKey(key)
    return ownProperties()[actual] ?: userValues[userKey(key)] ?: implied(key)
}

private fun InboxCard.implied(key: String): InboxValue? = when (key) {
    InboxFieldKeys.PAGE -> envelope?.takeIf { it.entityKind == InboxEntityKind.PAGE_CONTENT }?.target
        ?.let { InboxValue.Text(it) }
    InboxFieldKeys.FOLLOWUP_TASK -> followUpStep()?.let { InboxValue.Flag(it.enabled) }
    InboxFieldKeys.FOLLOW_DATE -> followUpStep()?.properties?.get(InboxFieldKeys.DATE)
    else -> null
}

/** The item ids the field [key] holds: its relation list, or the id(s) of a value that is no relation. */
fun InboxCard.idsOf(key: String): List<String> {
    ownRelations()[key]?.let { return it }
    return when (val value = valueOf(key)) {
        is InboxValue.Items -> value.ids
        is InboxValue.Text -> listOf(value.text).filter { it.isNotBlank() }
        is InboxValue.Flag, is InboxValue.NewOption, null -> emptyList()
    }
}

/** Whether the field [key] has no value to speak of: nothing, blank text or an empty list. */
fun InboxCard.isEmpty(key: String): Boolean = when (val value = valueOf(key)) {
    null -> idsOf(key).isEmpty()
    is InboxValue.Text -> value.text.isBlank() && idsOf(key).isEmpty()
    is InboxValue.Items -> value.ids.isEmpty()
    is InboxValue.Flag, is InboxValue.NewOption -> false
}
