package cz.semprec.app.domain

/** The controls a card editor field may declare; the server owns the list (`EDITOR_FIELD_CONTROLS`). */
enum class InboxControl { TEXT, AREA, DATE, DATETIME, SELECT, MULTI, TOGGLE, SEG, COLOR, SECRET, INFO, CHOICE, TILE }

/** The keyboard and validation hint of a [InboxControl.TEXT] field. */
enum class InboxInputType { TEXT, EMAIL, URL, TEL }

/**
 * The condition under which a field applies (or hides its time part): the field [field] of the same card holds
 * [value], or, when [negated], does not hold it. A field with no value is not equal to anything.
 */
data class InboxCondition(val field: String, val value: InboxValue, val negated: Boolean)

/**
 * One control of a card editor, as the server declares it for the kind of card. [label], [placeholder] and [info]
 * are already in the language of the person. [options] are the static values of a [InboxControl.SEG]; for a select
 * [optionsSource] names the options route.
 */
data class InboxField(
    val key: String,
    val control: InboxControl,
    val inputType: InboxInputType = InboxInputType.TEXT,
    val label: String = "",
    val placeholder: String? = null,
    val required: Boolean = false,
    val whenHolds: InboxCondition? = null,
    val timeHiddenWhen: InboxCondition? = null,
    val optionsSource: String? = null,
    val options: List<String> = emptyList(),
    val info: String? = null,
)

data class InboxGroup(val key: String, val fields: List<InboxField>)

/** The editor of one base kind of card. */
data class InboxSchema(val baseKind: String, val groups: List<InboxGroup>) {
    val fields: List<InboxField> get() = groups.flatMap { it.fields }
}

/** What the target database of a card says about one of its properties: the type and, for a select, the options. */
data class InboxPropertyInfo(val key: String, val type: InboxPropertyType, val options: List<InboxChoice>)

enum class InboxPropertyType { RELATION, SELECT, OTHER }

/**
 * One choice of a picker. [id] is the item id for an item picker and the option key for a select; it is `null` for the
 * "none" choice and for an item a step of the proposal would create (its [ref] says which step).
 */
data class InboxChoice(
    val id: String?,
    val label: String,
    val color: String? = null,
    val initials: String? = null,
    val hint: String? = null,
    val ref: String? = null,
    val date: String? = null,
    val timeFrom: String? = null,
    val timeTo: String? = null,
    val disabled: Boolean = false,
    val suggested: Boolean = false,
    val none: Boolean = false,
)
