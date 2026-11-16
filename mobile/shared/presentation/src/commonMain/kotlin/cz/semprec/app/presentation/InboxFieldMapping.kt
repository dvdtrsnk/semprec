package cz.semprec.app.presentation

import cz.semprec.app.domain.AUTO_LANGUAGE
import cz.semprec.app.domain.InboxCard
import cz.semprec.app.domain.InboxChoice
import cz.semprec.app.domain.InboxChoiceKeys
import cz.semprec.app.domain.InboxControl
import cz.semprec.app.domain.InboxField
import cz.semprec.app.domain.InboxFieldKeys
import cz.semprec.app.domain.InboxInputType
import cz.semprec.app.domain.InboxValue
import cz.semprec.app.domain.choicesOf
import cz.semprec.app.domain.chosenId
import cz.semprec.app.domain.idsOf
import cz.semprec.app.domain.isEdited
import cz.semprec.app.domain.isOn
import cz.semprec.app.domain.isTimeHidden
import cz.semprec.app.domain.missingFields
import cz.semprec.app.domain.optionsOf
import cz.semprec.app.domain.textOrNull
import cz.semprec.app.domain.valueOf
import cz.semprec.app.domain.visibleFields

private const val DATE_LENGTH = 10

internal fun InboxChoice.toItem(selected: Boolean, isNew: Boolean = false) = InboxChoiceItem(
    id = id,
    label = label,
    color = color,
    initials = initials,
    hint = hint,
    date = date,
    timeFrom = timeFrom,
    timeTo = timeTo,
    selected = selected,
    disabled = disabled || ref != null,
    suggested = suggested,
    none = none,
    isNew = isNew,
)

/** The choices a field offers now: what the card knows, else the items asked for from the server. */
internal fun InboxModel.choicesFor(card: InboxCard, field: InboxField): List<InboxChoice> = when {
    field.control == InboxControl.CHOICE || field.control == InboxControl.TILE -> card.choicesOf(field, types)
    else -> card.optionsOf(field)
        ?: field.optionsSource?.let { choices[choicesKey(card.id, it)] }.orEmpty()
}

/** The ids of what the field holds now; a language that is not set is the automatic one. */
internal fun InboxModel.selectedIds(card: InboxCard, field: InboxField): List<String> = when {
    field.key == InboxChoiceKeys.TYPE -> listOfNotNull(answersOf(card.id).typeId)
    field.control == InboxControl.CHOICE -> listOfNotNull(card.chosenId(field))
    field.key == InboxFieldKeys.LANGUAGE -> listOf(card.valueOf(field.key).textOrNull ?: AUTO_LANGUAGE)
    field.key == InboxFieldKeys.EVENT_ID && card.valueOf(InboxFieldKeys.NO_EVENT).isOn -> emptyList()
    else -> card.idsOf(field.key)
}

private fun InboxModel.selectedItems(
    card: InboxCard,
    field: InboxField,
    options: List<InboxChoice>,
): List<InboxChoiceItem> {
    val value = card.valueOf(field.key)
    return when {
        // The file of a file card is the attachment that is stored: it is shown by the name it is given.
        field.key == InboxFieldKeys.FILE -> listOfNotNull(
            card.valueOf(InboxFieldKeys.NAME).textOrNull?.let { InboxChoice(null, it).toItem(selected = true) },
        )
        value is InboxValue.NewOption -> listOf(InboxChoice(null, value.label).toItem(selected = true, isNew = true))
        else -> selectedIds(card, field).map { id ->
            (options.firstOrNull { it.id == id } ?: InboxChoice(id, "")).toItem(selected = true)
        }
    }
}

internal fun InboxModel.fieldState(card: InboxCard, field: InboxField, missing: Set<String>): InboxFieldState {
    val value = card.valueOf(field.key)
    val options = choicesFor(card, field)
    val inline = field.control in INLINE_CONTROLS
    val selected = selectedItems(card, field, options)
    val selectedIds = selected.mapNotNull { it.id }.toSet()
    return InboxFieldState(
        key = field.key,
        type = field.control.toFieldType(),
        keyboard = field.inputType.toKeyboard(),
        label = field.label,
        placeholder = field.placeholder,
        required = field.required,
        missing = field.key in missing,
        edited = card.isEdited(field.key),
        text = if (field.control == InboxControl.SECRET) "" else value.textOrNull.orEmpty(),
        flag = if (field.control == InboxControl.SECRET) !answersOf(card.id).secret.isNullOrEmpty() else value.isOn,
        date = value.textOrNull?.take(DATE_LENGTH)?.takeIf { it.isNotEmpty() },
        time = card.valueOf(InboxFieldKeys.TIME_FROM).textOrNull?.takeIf { field.control == InboxControl.DATETIME },
        showTime = field.control == InboxControl.DATETIME && !card.isTimeHidden(field),
        selected = selected,
        options = if (inline) options.map { it.toItem(selected = it.id in selectedIds) } else emptyList(),
        needsPicker = field.control == InboxControl.SELECT || field.control == InboxControl.MULTI,
        info = field.info,
    )
}

/** The fields that show their choices in the card itself; a select or a multi-value field opens a picker. */
private val INLINE_CONTROLS = setOf(InboxControl.SEG, InboxControl.COLOR, InboxControl.CHOICE, InboxControl.TILE)

/** The state of every visible field of [groups], with the ones that block the approval marked. */
internal fun InboxModel.groupStates(card: InboxCard, groups: List<cz.semprec.app.domain.InboxGroup>) =
    card.missingFields(answersOf(card.id)).map { it.key }.toSet().let { missing ->
        groups.map { group ->
            InboxGroupState(group.key, group.fields.map { fieldState(card, it, missing) })
        }
    }

private fun InboxControl.toFieldType() = when (this) {
    InboxControl.TEXT -> InboxFieldType.TEXT
    InboxControl.AREA -> InboxFieldType.AREA
    InboxControl.DATE -> InboxFieldType.DATE
    InboxControl.DATETIME -> InboxFieldType.DATETIME
    InboxControl.SELECT -> InboxFieldType.SELECT
    InboxControl.MULTI -> InboxFieldType.MULTI
    InboxControl.TOGGLE -> InboxFieldType.TOGGLE
    InboxControl.SEG -> InboxFieldType.SEG
    InboxControl.COLOR -> InboxFieldType.COLOR
    InboxControl.SECRET -> InboxFieldType.SECRET
    InboxControl.INFO -> InboxFieldType.INFO
    InboxControl.CHOICE -> InboxFieldType.CHOICE
    InboxControl.TILE -> InboxFieldType.TILE
}

private fun InboxInputType.toKeyboard() = when (this) {
    InboxInputType.TEXT -> InboxKeyboard.TEXT
    InboxInputType.EMAIL -> InboxKeyboard.EMAIL
    InboxInputType.URL -> InboxKeyboard.URL
    InboxInputType.TEL -> InboxKeyboard.TEL
}

/** The picker that is open, with the choices of its field and the one that is chosen. */
internal fun InboxModel.pickerState(): InboxPickerState? {
    val ref = picker
    val card = ref?.let { card(it.cardId) }
    val field = card?.visibleFields()?.firstOrNull { it.key == ref.key }
    return if (card == null || field == null) null else pickerOf(card, field)
}

private fun InboxModel.pickerOf(card: InboxCard, field: InboxField): InboxPickerState {
    val source = field.optionsSource?.let { choicesKey(card.id, it) }
    val phase = when {
        source == null || source in choices -> InboxPickerPhase.READY
        source in failed -> InboxPickerPhase.ERROR
        else -> InboxPickerPhase.LOADING
    }
    val chosen = selectedIds(card, field).toSet()
    return InboxPickerState(
        cardId = card.id,
        key = field.key,
        multi = field.control == InboxControl.MULTI,
        phase = phase,
        options = choicesFor(card, field).map { it.toItem(selected = it.id in chosen) },
    )
}
