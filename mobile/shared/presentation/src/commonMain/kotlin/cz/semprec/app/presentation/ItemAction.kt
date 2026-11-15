package cz.semprec.app.presentation

sealed interface ItemAction {
    data object Retry : ItemAction

    /** Reads the item again over what is on screen, for when the screen appears again. */
    data object Refresh : ItemAction

    /** Writes the title, sent when the person submits it. */
    data class Rename(val title: String) : ItemAction

    /** Writes a text-like property (text, long text, link, date, time); an empty text clears it. */
    data class SetText(val propertyKey: String, val text: String) : ItemAction

    /** Writes a number property; `null` clears it. */
    data class SetNumber(val propertyKey: String, val number: Double?) : ItemAction
    data class SetFlag(val propertyKey: String, val on: Boolean) : ItemAction

    /** Writes a select (one key or none) or multi-select (any number of keys). */
    data class SetChoices(val propertyKey: String, val keys: List<String>) : ItemAction

    /** Ends the link that makes a value follow its source; the value stays as the item's own. */
    data class Unlink(val propertyKey: String) : ItemAction

    /** Makes the value follow its source again. */
    data class Relink(val propertyKey: String) : ItemAction
    data class OpenPicker(val propertyKey: String) : ItemAction
    data class SearchPicker(val text: String) : ItemAction
    data class Pick(val targetId: String) : ItemAction
    data object ClosePicker : ItemAction
    data class RemoveTarget(val propertyKey: String, val targetId: String) : ItemAction

    /** Replaces the item's page with this Markdown. */
    data class SavePage(val markdown: String) : ItemAction
    data object ReloadPage : ItemAction
    data class LoadPreview(val propertyKey: String) : ItemAction
    data object ClosePreview : ItemAction
    data object RequestDelete : ItemAction
    data object CancelDelete : ItemAction
    data object ConfirmDelete : ItemAction
    data class OpenRelated(val databaseId: String) : ItemAction
    data class OpenTarget(val id: String, val databaseKey: String?) : ItemAction
    data object DismissWriteFailure : ItemAction
}
