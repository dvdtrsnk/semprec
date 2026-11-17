package cz.semprec.app.core

/** What an item of the shared Podrobnosti sheet is: a task, or an event of the calendar. */
enum class ItemKind { TASK, EVENT }

/** The state of a task. [MISSED] is set by the server when a repeating task was not done on its day. */
enum class TaskStatus { NOT_DONE, DONE, WONT_DO, MISSED }

/** How a task repeats; [CUSTOM] is a rule the app shows but does not edit. */
enum class TaskRepeat { NONE, DAILY, WEEKDAYS, WEEKLY, MONTHLY, CUSTOM }

/** How a value of an item is tied to its source: followed, followed once and since changed, or always computed. */
enum class LinkState { INHERITED, BROKEN, DERIVED }

/** The values of an item that can follow another item: the project and the people of a task or an event. */
enum class LinkedValue { PROJECT, PEOPLE }

/** A thing an item points at: a person, a file, an event, a company. [color] is a `#RRGGBB` string when it has one. */
data class EntityRef(val id: String, val title: String, val color: String? = null)

/** A project with the area it belongs to. */
data class ProjectRef(
    val id: String,
    val title: String,
    val color: String? = null,
    val areaId: String? = null,
    val areaTitle: String? = null,
)

/** Where a followed value comes from ([sourceTitle]) and, once broken, whether Semp broke it ([brokenBySemp]). */
data class ValueLink(val state: LinkState, val sourceTitle: String? = null, val brokenBySemp: Boolean = false)
