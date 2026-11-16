package cz.semprec.app.domain

import cz.semprec.app.core.EntityRef
import cz.semprec.app.core.ItemKind
import cz.semprec.app.core.LinkedValue
import cz.semprec.app.core.ProjectRef
import cz.semprec.app.core.TaskRepeat
import cz.semprec.app.core.TaskStatus
import cz.semprec.app.core.ValueLink

/** When something happens: a [date] with an optional start and end time (no start time means all day). */
data class Schedule(
    val date: String?,
    val timeFrom: String?,
    val timeTo: String?,
    val endDate: String? = null,
)

/**
 * A task or an event as the shared Podrobnosti sheet and the task lists show it. Fields that only one kind has are
 * empty for the other: tasks have a [status], a [flagged] mark, an [effectiveDate] and a [repeat]; events have a
 * [place], an [endDate] and a [company]. [version] is what the next write must name (`ifVersion`).
 */
data class WorkItem(
    val kind: ItemKind,
    val id: String,
    val version: String,
    val title: String,
    val schedule: Schedule,
    val description: String = "",
    val status: TaskStatus = TaskStatus.NOT_DONE,
    val effectiveDate: String? = null,
    val flagged: Boolean = false,
    val repeat: TaskRepeat = TaskRepeat.NONE,
    val place: String = "",
    val project: ProjectRef? = null,
    val people: List<EntityRef> = emptyList(),
    val files: List<EntityRef> = emptyList(),
    val hostEvents: List<EntityRef> = emptyList(),
    val company: EntityRef? = null,
    val projectLink: ValueLink? = null,
    val peopleLink: ValueLink? = null,
)

/** Which tasks a list asks for; each is a superset of the one before it. */
enum class TaskScope { TODAY, PLANNED, ALL }

/** What a person can change on a task or an event; the repository turns each into writes. */
sealed interface ItemChange {
    data class Title(val text: String) : ItemChange
    data class Done(val done: Boolean) : ItemChange
    data class Description(val text: String) : ItemChange
    data class Place(val text: String) : ItemChange
    data class Flagged(val flagged: Boolean) : ItemChange
    data class Reschedule(val schedule: Schedule) : ItemChange
    data class Repeat(val repeat: TaskRepeat) : ItemChange

    /** `null` is no project. */
    data class Project(val projectId: String?) : ItemChange
    data class AddPerson(val personId: String) : ItemChange
    data class RemovePerson(val personId: String) : ItemChange
    data class RemoveFile(val fileId: String) : ItemChange
    data class Unlink(val value: LinkedValue) : ItemChange
    data class Relink(val value: LinkedValue) : ItemChange
}

/** What a person can pick for the project and the people of an item. */
data class Choices(val projects: List<ProjectRef>, val people: List<EntityRef>)

/** A task to create: it lands on [date] (`null` is no date) and in [projectId] when one is named. */
data class NewTask(val title: String, val date: String?, val projectId: String?)
