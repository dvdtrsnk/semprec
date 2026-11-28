package cz.alldots.app.presentation

sealed interface ItemAction {
    data object Retry : ItemAction

    /** Reads the item again over what is on screen, for when the screen appears again. */
    data object Refresh : ItemAction
    data object DismissWriteFailure : ItemAction

    /** Writes to the item's properties and values. */
    sealed interface Edit : ItemAction {
        /** Writes the title, sent when the person submits it. */
        data class Rename(val title: String) : Edit

        /** Writes a text-like property (text, long text, link, date, time); an empty text clears it. */
        data class SetText(val propertyKey: String, val text: String) : Edit

        /** Writes a number property; `null` clears it. */
        data class SetNumber(val propertyKey: String, val number: Double?) : Edit
        data class SetFlag(val propertyKey: String, val on: Boolean) : Edit

        /** Writes a select (one key or none) or multi-select (any number of keys). */
        data class SetChoices(val propertyKey: String, val keys: List<String>) : Edit

        /** Writes a choice of the select or multi-select [propertyKey] itself, for every item of the database. */
        sealed interface Choice : Edit {
            val propertyKey: String
        }

        /**
         * Adds a new choice named [label] to a select or multi-select and sets it on the item, a multi-select keeping
         * the choices it holds; a blank name changes nothing.
         */
        data class AddChoice(override val propertyKey: String, val label: String) : Choice

        /** Renames the choice [key] to [label]; a blank name changes nothing. */
        data class RenameChoice(override val propertyKey: String, val key: String, val label: String) : Choice

        /** Gives the choice [key] the [color] (`#RRGGBB`). */
        data class RecolorChoice(override val propertyKey: String, val key: String, val color: String) : Choice

        /** Removes the choice [key], and with it the key from every item that holds it. */
        data class RemoveChoice(override val propertyKey: String, val key: String) : Choice

        /** Ends the link that makes a value follow its source; the value stays as the item's own. */
        data class Unlink(val propertyKey: String) : Edit

        /** Makes the value follow its source again. */
        data class Relink(val propertyKey: String) : Edit
        data class RemoveTarget(val propertyKey: String, val targetId: String) : Edit
    }

    /** Points a relation at another item. */
    sealed interface Picker : ItemAction {
        data class Open(val propertyKey: String) : Picker
        data class Search(val text: String) : Picker
        data class Choose(val targetId: String) : Picker
        data object Close : Picker
    }

    sealed interface Page : ItemAction {
        /** Replaces the item's page with this Markdown. */
        data class Save(val markdown: String) : Page
        data object Reload : Page
    }

    sealed interface Preview : ItemAction {
        data class Load(val propertyKey: String) : Preview
        data object Close : Preview
    }

    sealed interface Deletion : ItemAction {
        data object Request : Deletion
        data object Cancel : Deletion
        data object Confirm : Deletion
    }

    sealed interface Navigate : ItemAction {
        data class OpenRelated(val databaseId: String) : Navigate
        data class OpenTarget(val id: String, val databaseKey: String?) : Navigate
    }
}
