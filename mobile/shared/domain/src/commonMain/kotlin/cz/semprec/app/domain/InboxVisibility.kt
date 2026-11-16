package cz.semprec.app.domain

/** Whether [condition] holds for the values of this card; a field without a value equals nothing. */
fun InboxCard.holds(condition: InboxCondition): Boolean {
    val actual = valueOf(condition.field)
    val equal = when (val wanted = condition.value) {
        is InboxValue.Text -> actual.textOrNull == wanted.text
        is InboxValue.Flag -> actual is InboxValue.Flag && actual.on == wanted.on
        is InboxValue.NewOption, is InboxValue.Items -> false
    }
    return equal != condition.negated
}

/**
 * Whether the editor shows [field]: its condition holds, and a follow-up field only when the proposal has a
 * follow-up task to switch.
 */
fun InboxCard.isVisible(field: InboxField): Boolean {
    val followUp = field.key == InboxFieldKeys.FOLLOWUP_TASK || field.key == InboxFieldKeys.FOLLOW_DATE
    return (field.whenHolds?.let { holds(it) } ?: true) && (!followUp || followUpStep() != null)
}

/** Whether the time of [field] is hidden by what the card holds (an all-day task has no time of day). */
fun InboxCard.isTimeHidden(field: InboxField): Boolean = field.timeHiddenWhen?.let { holds(it) } ?: false

/** Whether the person changed the field [key] of this card in this session. */
fun InboxCard.isEdited(key: String): Boolean {
    val ref = envelope?.primaryRef ?: InboxEnvelope.SINGLE_STEP_REF
    val actual = propertyKey(key)
    return "$ref.$actual" in editedKeys || "$ref.relations.$actual" in editedKeys || "$ref.$key" in editedKeys
}
