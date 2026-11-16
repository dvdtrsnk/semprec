package cz.semprec.app.domain

/**
 * One value of a proposal: a text (dates, times, numbers and ids are texts too), a switch, or the label of a select
 * option the proposal asks to create when it is approved.
 */
sealed interface InboxValue {
    data class Text(val text: String) : InboxValue
    data class Flag(val on: Boolean) : InboxValue
    data class NewOption(val label: String) : InboxValue

    /** The item ids of a multi-value field the person changed. */
    data class Items(val ids: List<String>) : InboxValue
}

/** The text of a [InboxValue.Text], or `null` for any other value or none. */
val InboxValue?.textOrNull: String? get() = (this as? InboxValue.Text)?.text

/** The switch of a [InboxValue.Flag], `false` for any other value or none. */
val InboxValue?.isOn: Boolean get() = (this as? InboxValue.Flag)?.on == true
