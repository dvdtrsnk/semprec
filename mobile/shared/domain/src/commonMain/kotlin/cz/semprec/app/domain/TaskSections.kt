package cz.semprec.app.domain

import cz.semprec.app.core.TaskSectionKind
import cz.semprec.app.core.TaskStatus
import cz.semprec.app.core.TasksTab

/** The narrowing of a task list the person chose: by area, by project, to flagged tasks only. */
data class TaskFilter(
    val areaId: String? = null,
    val projectId: String? = null,
    val flaggedOnly: Boolean = false,
) {
    val isActive: Boolean get() = areaId != null || projectId != null || flaggedOnly

    fun matches(item: WorkItem): Boolean =
        (areaId == null || item.project?.areaId == areaId) &&
            (projectId == null || item.project?.id == projectId) &&
            (!flaggedOnly || item.flagged)
}

/** A group of a task list. */
data class TaskSection(val kind: TaskSectionKind, val items: List<WorkItem>)

/** Groups tasks by the day they are on, as the Tasks board does. */
object TaskSections {
    private const val WEEK_DAYS = 9
    private const val NO_DATE = "9999-99-99"
    private const val NO_TIME = "99:99"

    /** The groups [tab] shows, in order. */
    fun kinds(tab: TasksTab): List<TaskSectionKind> = when (tab) {
        TasksTab.TODAY -> listOf(TaskSectionKind.LATE, TaskSectionKind.TODAY)
        TasksTab.PLANNED -> listOf(
            TaskSectionKind.LATE,
            TaskSectionKind.TODAY,
            TaskSectionKind.TOMORROW,
            TaskSectionKind.WEEK,
            TaskSectionKind.LATER,
        )
        TasksTab.ALL -> TaskSectionKind.entries
    }

    /**
     * The group of [item] on [today]: by its effective day, which the server moves forward at midnight for a task not
     * done. A task done today belongs to today whatever day it was planned for.
     */
    fun kindOf(item: WorkItem, today: IsoDate): TaskSectionKind {
        val day = (item.effectiveDate ?: item.schedule.date)?.let(IsoDate::parse) ?: return TaskSectionKind.NONE
        val distance = today.daysUntil(day)
        return when {
            distance < 0 -> if (item.status == TaskStatus.DONE) TaskSectionKind.TODAY else TaskSectionKind.LATE
            distance == 0 -> TaskSectionKind.TODAY
            distance == 1 -> TaskSectionKind.TOMORROW
            distance <= WEEK_DAYS -> TaskSectionKind.WEEK
            else -> TaskSectionKind.LATER
        }
    }

    /** [items] grouped for [tab], each group ordered by day, start time and title; tasks of no shown group drop out. */
    fun group(items: List<WorkItem>, today: IsoDate, tab: TasksTab): List<TaskSection> {
        val byKind = items.groupBy { kindOf(it, today) }
        return kinds(tab).map { kind ->
            TaskSection(kind, (byKind[kind] ?: emptyList()).sortedWith(ORDER))
        }
    }

    private val ORDER = compareBy<WorkItem>(
        { it.effectiveDate ?: it.schedule.date ?: NO_DATE },
        { it.schedule.timeFrom?.padStart(TIME_WIDTH, '0') ?: NO_TIME },
        { it.title.lowercase() },
    )

    private const val TIME_WIDTH = 5
}
