package cz.alldots.app.domain

/**
 * The card as it will be once the server has saved [edit]: the values, relation lists and step switches laid over its
 * proposal. The screen shows it at once; the server's answer replaces it. A value of `null` clears the property.
 */
fun InboxCard.applying(edit: InboxEdit): InboxCard {
    val envelope = envelope ?: return this
    val steps = envelope.steps.map { step ->
        step.copy(
            properties = step.properties.laidOver(edit.values[step.ref]),
            relations = step.relations + edit.relations[step.ref].orEmpty(),
            enabled = edit.steps[step.ref] ?: step.enabled,
        )
    }
    val primary = steps.firstOrNull { it.primary }
    val ref = envelope.primaryRef
    return copy(
        envelope = envelope.copy(
            properties = primary?.properties ?: envelope.properties.laidOver(edit.values[ref]),
            relations = primary?.relations ?: (envelope.relations + edit.relations[ref].orEmpty()),
            steps = steps,
        ),
    )
}

private fun Map<String, InboxValue>.laidOver(values: Map<String, InboxValue?>?): Map<String, InboxValue> {
    if (values == null) return this
    val kept = filterKeys { it !in values.keys }
    return kept + values.mapNotNull { (key, value) -> value?.let { key to it } }
}

/**
 * This card, read again from the stack, with what the person set in this session when the card is the very version
 * they set it on: the stack does not carry their values, and a card another party changed has none of them any more.
 */
fun InboxCard.carrying(previous: InboxCard?): InboxCard =
    if (previous != null && previous.version == version) {
        copy(userValues = previous.userValues, editedKeys = previous.editedKeys)
    } else {
        this
    }
