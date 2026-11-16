package cz.semprec.app.domain

/** Whether a card may be approved now, and if not, why. The button of the card is enabled only when [READY]. */
enum class InboxReadiness {
    READY,

    /** A visible required field has no value yet (or no type is chosen on a card that asks for one). */
    MISSING_FIELDS,

    /** Semp is still computing the proposal. */
    COMPUTING,

    /** The computation failed or timed out; it can be asked for again. */
    COMPUTE_FAILED,

    /** The proposal cannot be used as it is; an edit makes it usable (the server then drops its reason). */
    INVALID,

    /** A card of a kind this version does not know. */
    UNSUPPORTED,
}

/** What the person has put beside the card that the card itself does not hold. */
data class InboxAnswers(val typeId: String? = null, val secret: String? = null)

/**
 * The visible required fields of the card that have no value, in editor order. A date-and-time field has its date as
 * the value; the file of a file card and a read-only note are never missing, because the person cannot fill them.
 */
fun InboxCard.missingFields(answers: InboxAnswers = InboxAnswers()): List<InboxField> =
    visibleFields().filter { it.required && isMissing(it, answers) }

private fun InboxCard.isMissing(field: InboxField, answers: InboxAnswers): Boolean = when {
    field.control == InboxControl.INFO || field.key == InboxFieldKeys.FILE -> false
    field.control == InboxControl.SECRET -> answers.secret.isNullOrEmpty()
    field.key == InboxChoiceKeys.TYPE -> answers.typeId == null
    field.key == InboxChoiceKeys.MATCH -> chosenId(field) == null && envelope?.entityKind != InboxEntityKind.DATABASE
    field.control == InboxControl.CHOICE -> chosenId(field) == null
    field.key == InboxFieldKeys.DAY && envelope?.entityKind == InboxEntityKind.PAGE_CONTENT -> false
    else -> isEmpty(field.key)
}

/** Decides whether the card may be approved now. */
fun InboxCard.readiness(answers: InboxAnswers = InboxAnswers()): InboxReadiness = when {
    kind == InboxCardKind.UNSUPPORTED -> InboxReadiness.UNSUPPORTED
    kind == InboxCardKind.APPROVAL -> InboxReadiness.READY
    status == InboxCardStatus.COMPUTING -> InboxReadiness.COMPUTING
    status == InboxCardStatus.COMPUTE_FAILED -> InboxReadiness.COMPUTE_FAILED
    status == InboxCardStatus.INVALID -> InboxReadiness.INVALID
    missingFields(answers).isNotEmpty() -> InboxReadiness.MISSING_FIELDS
    else -> InboxReadiness.READY
}
