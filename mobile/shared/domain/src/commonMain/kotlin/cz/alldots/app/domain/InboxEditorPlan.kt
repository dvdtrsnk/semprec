package cz.alldots.app.domain

private val speakerGroups = listOf(
    InboxGroup("choice", listOf(InboxField(InboxChoiceKeys.WHO, InboxControl.CHOICE, required = true))),
)
private val matchGroups = listOf(
    InboxGroup("choice", listOf(InboxField(InboxChoiceKeys.MATCH, InboxControl.CHOICE, required = true))),
)
private val clarifyGroups = listOf(
    InboxGroup("choice", listOf(InboxField(InboxChoiceKeys.TYPE, InboxControl.TILE, required = true))),
)

/**
 * The editor of a recording card. The server declares none for it: these are the parameters a recording proposal
 * takes (`name`, `language`, `eventId`, `projectId`, `noEvent`).
 */
private val recordingGroups = listOf(
    InboxGroup(
        "recording",
        listOf(
            InboxField(InboxFieldKeys.NAME, InboxControl.TEXT, required = true),
            InboxField(InboxFieldKeys.LANGUAGE, InboxControl.SEG, options = listOf(AUTO_LANGUAGE, "cs", "en")),
            InboxField(InboxFieldKeys.EVENT_ID, InboxControl.SELECT),
            InboxField(InboxFieldKeys.PROJECT_ID, InboxControl.SELECT, optionsSource = "project"),
        ),
    ),
)

/**
 * The groups of fields the card shows, whatever the visible conditions say (see [visibleGroups]): the editor schema
 * of the server, completed by the choices the card asks for. A card that is only decided (an approval, a kind this
 * app does not know) has none.
 */
fun InboxCard.editorGroups(): List<InboxGroup> = when (kind) {
    InboxCardKind.APPROVAL, InboxCardKind.UNSUPPORTED -> emptyList()
    InboxCardKind.SPEAKER -> speakerGroups
    InboxCardKind.CLARIFY -> clarifyGroups
    InboxCardKind.TRANSCRIPT_EVENT ->
        matchGroups + if (envelope?.entityKind == InboxEntityKind.DATABASE) schema?.groups.orEmpty() else emptyList()
    InboxCardKind.RECORDING -> recordingGroups
    else -> schema?.groups.orEmpty()
}

/** The groups the card shows now: only the fields whose condition holds, and no group left empty. */
fun InboxCard.visibleGroups(): List<InboxGroup> =
    editorGroups().map { group -> group.copy(fields = group.fields.filter { isVisible(it) }) }
        .filter { it.fields.isNotEmpty() }

/** Every field the card shows now, in order. */
fun InboxCard.visibleFields(): List<InboxField> = visibleGroups().flatMap { it.fields }

/**
 * The options of [field] the card knows without asking the server: the static values of a segmented control, the
 * options of the select property of the destination and the events a recording may belong to. `null` when the
 * options of an item picker have to be asked for.
 */
fun InboxCard.optionsOf(field: InboxField): List<InboxChoice>? = when {
    field.optionsSource != null -> null
    field.control == InboxControl.SEG && field.options.isNotEmpty() ->
        field.options.map { InboxChoice(id = it, label = "") }
    field.key == InboxFieldKeys.EVENT_ID -> recordingEvents()
    field.control == InboxControl.COLOR || field.control == InboxControl.SELECT || field.control == InboxControl.SEG ->
        properties[propertyKey(field.key)]?.options.orEmpty()
    else -> emptyList()
}

private fun InboxCard.recordingEvents(): List<InboxChoice> {
    val events = (context as? InboxContext.Recording)?.candidates.orEmpty()
    return events.map { it.toChoice() } +
        InboxChoice(id = null, label = "", none = true)
}

/** The options a card of the kind CHOICE asks the person to pick from; the types are the ones the server lists. */
fun InboxCard.choicesOf(field: InboxField, types: List<InboxType>): List<InboxChoice> = when (field.key) {
    InboxChoiceKeys.WHO -> (context as? InboxContext.Speaker)?.alternatives.orEmpty().map { it.toChoice() }
    InboxChoiceKeys.MATCH -> (context as? InboxContext.Meeting)?.candidates.orEmpty()
        .map { it.toChoice().copy(suggested = it.id == (context as InboxContext.Meeting).recommended) }
    InboxChoiceKeys.TYPE -> types.map {
        InboxChoice(id = it.id, label = it.label, hint = it.targetLabel, initials = it.emoji)
    }
    else -> emptyList()
}

private fun InboxCandidate.toChoice() =
    InboxChoice(id = id, label = label, hint = detail, date = date, timeFrom = timeFrom, timeTo = timeTo)

/** The id of the choice the proposal holds now, for the cards that offer a choice; `null` while nothing is chosen. */
fun InboxCard.chosenId(field: InboxField): String? {
    val link = envelope?.takeIf { it.entityKind == InboxEntityKind.RELATION }?.target
    return when (field.key) {
        InboxChoiceKeys.WHO -> link
        InboxChoiceKeys.MATCH -> link
        else -> null
    }
}

/** The change that picks [choice] on a card of choices: a new proposal of the card, or none for a type. */
fun InboxCard.revisionOf(field: InboxField, choice: InboxChoice): InboxRevision? {
    val id = choice.id ?: return null
    val speaker = (context as? InboxContext.Speaker)?.speaker
    return when {
        field.key == InboxChoiceKeys.WHO && speaker != null -> InboxRevision.LinkSpeaker(id, speaker)
        field.key == InboxChoiceKeys.MATCH -> InboxRevision.LinkEvent(id)
        else -> null
    }
}
