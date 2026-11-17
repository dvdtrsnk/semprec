package cz.semprec.app.presentation

/** How a native screen draws and edits a property. */
enum class FieldKind { TEXT, LONG_TEXT, NUMBER, SELECT, MULTI_SELECT, DATE, TIME, CHECKBOX, RELATION, FILE, URL }

/** A choice of a select property, its label already in the language of the signed-in person. */
data class OptionView(val key: String, val label: String, val color: String?)

/** An item another item points at. [databaseKey] is `null` for a database a person created. */
data class TargetView(val id: String, val databaseKey: String?, val title: String, val color: String?)

/** What a property holds, ready to draw; nothing in it is display text the app has to translate. */
sealed interface FieldContent {
    data object Empty : FieldContent
    data class Text(val text: String) : FieldContent
    data class Number(val number: Double) : FieldContent
    data class Flag(val on: Boolean) : FieldContent

    /** A calendar day or a date with a time, as the server stores it (`YYYY-MM-DD` or an ISO date-time). */
    data class Day(val iso: String) : FieldContent

    /** A time of day, `HH:mm`. */
    data class Clock(val time: String) : FieldContent
    data class Link(val url: String) : FieldContent
    data class Choices(val options: List<OptionView>) : FieldContent
    data class Targets(val targets: List<TargetView>) : FieldContent
    data class Blob(val blobId: String, val filename: String?, val mimeType: String, val byteSize: Long) : FieldContent
}

/** Where a value comes from; see the three kinds of values of the design principles. */
enum class OriginKind { INHERITED, INHERITED_BROKEN, DERIVED }

/** Who ended a link that made a value follow its source. */
enum class OriginAuthor { USER, AGENT }

/** The item a value is taken from. [title] is empty when the server did not name it. */
data class OriginSourceView(val itemId: String?, val databaseKey: String?, val title: String)

/** The origin of a value that is not the item's own. */
data class OriginView(val kind: OriginKind, val sources: List<OriginSourceView>, val brokenBy: OriginAuthor?)

/**
 * One property of an item. [editable] says whether the person
 * may change it here, [options] is the choice list of a select.
 */
data class FieldView(
    val propertyKey: String,
    val name: String,
    val kind: FieldKind,
    val content: FieldContent,
    val options: List<OptionView>,
    val editable: Boolean,
    val origin: OriginView?,
)
