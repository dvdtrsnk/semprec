package cz.semprec.app.presentation

import cz.semprec.app.core.FailureKind
import cz.semprec.app.core.TaskRepeat
import cz.semprec.app.core.TaskSectionKind
import cz.semprec.app.core.TasksTab

enum class TasksPhase { LOADING, CONTENT, ERROR }

/**
 * One task of a list. [date] is the day it is on (the server moves a task not done forward at midnight), [movedFrom]
 * the day it was planned for when that is earlier; native code turns both into words. [overdue] marks a task still not
 * done on a day before today, [missed] a repeating task that was not done on its day.
 */
data class TaskRow(
    val id: String,
    val title: String,
    val done: Boolean,
    val flagged: Boolean,
    val date: String?,
    val timeFrom: String?,
    val timeTo: String?,
    val movedFrom: String?,
    val projectTitle: String?,
    val repeat: TaskRepeat,
    val overdue: Boolean,
    val missed: Boolean,
)

data class TaskGroup(val kind: TaskSectionKind, val rows: List<TaskRow>)

/** One choice of the filter sheet and the number of tasks it leaves. [areaId] is the area of a project choice. */
data class TaskFilterOption(
    val id: String,
    val title: String,
    val color: String?,
    val count: Int,
    val areaId: String? = null,
)

/**
 * The Tasks screen. The filter is [areaId], [projectId] and [flaggedOnly]; [groups] are what it leaves, grouped by
 * day, and [matchesNothing] says a filter hid every task. [notice] is a failed write; the list shows what the server
 * holds again.
 */
data class TasksState(
    val phase: TasksPhase = TasksPhase.LOADING,
    val failure: FailureKind? = null,
    val tab: TasksTab = TasksTab.TODAY,
    val hideDone: Boolean = false,
    val areaId: String? = null,
    val projectId: String? = null,
    val flaggedOnly: Boolean = false,
    val groups: List<TaskGroup> = emptyList(),
    val openCount: Int = 0,
    val areaOptions: List<TaskFilterOption> = emptyList(),
    val projectOptions: List<TaskFilterOption> = emptyList(),
    val areaAllCount: Int = 0,
    val projectAllCount: Int = 0,
    val matchesNothing: Boolean = false,
    val notice: FailureKind? = null,
) {
    val filterActive: Boolean get() = areaId != null || projectId != null || flaggedOnly
}
