package cz.semprec.app.presentation

import cz.semprec.app.core.EntityRef
import cz.semprec.app.core.ProjectRef
import cz.semprec.app.core.TaskSectionKind
import cz.semprec.app.core.TaskStatus
import cz.semprec.app.domain.IsoDate
import cz.semprec.app.domain.TaskFilter
import cz.semprec.app.domain.TaskSections
import cz.semprec.app.domain.WorkItem

/** The areas and projects the filter sheet offers. */
internal class TasksCatalog(val areas: List<EntityRef> = emptyList(), val projects: List<ProjectRef> = emptyList())

/** [this] after a filter action; any other action leaves it as it is. Choosing another area drops a project of its own. */
internal fun TasksState.after(action: TasksAction, projects: List<ProjectRef>): TasksState = when (action) {
    TasksAction.ToggleHideDone -> copy(hideDone = !hideDone)
    is TasksAction.SetArea -> {
        val projectArea = projects.firstOrNull { it.id == projectId }?.areaId
        val keepsProject = projectId == null || action.areaId == null || projectArea == action.areaId
        copy(areaId = action.areaId, projectId = if (keepsProject) projectId else null)
    }
    is TasksAction.SetProject -> copy(projectId = action.projectId)
    is TasksAction.SetFlaggedOnly -> copy(flaggedOnly = action.flaggedOnly)
    TasksAction.ClearFilters -> copy(areaId = null, projectId = null, flaggedOnly = false)
    else -> this
}

/**
 * [this] with the groups, counts and options that [loaded], its filter and its tab give on [today]. Nothing is shaped
 * before the tasks loaded, or when [today] is no day.
 */
internal fun TasksState.shaped(loaded: List<WorkItem>, catalog: TasksCatalog, today: String): TasksState {
    val day = IsoDate.parse(today)
    if (phase != TasksPhase.CONTENT || day == null) return this
    val filter = TaskFilter(areaId, projectId, flaggedOnly)
    val matching = loaded.filter(filter::matches)
    val shown = if (hideDone) matching.filter { it.status != TaskStatus.DONE } else matching
    val groups = TaskSections.group(shown, day, tab)
        .filter { it.items.isNotEmpty() || it.kind == TaskSectionKind.TODAY }
        .map { section -> TaskGroup(section.kind, section.items.map { it.toRow(day) }) }
    fun count(narrowed: TaskFilter): Int = loaded.count(narrowed::matches)
    return copy(
        groups = groups,
        openCount = matching.count { it.status != TaskStatus.DONE },
        areaOptions = catalog.areas.map { area ->
            TaskFilterOption(area.id, area.title, area.color, count(filter.copy(areaId = area.id)))
        },
        projectOptions = catalog.projects.filter { areaId == null || it.areaId == areaId }.map { project ->
            val narrowed = filter.copy(projectId = project.id)
            TaskFilterOption(project.id, project.title, project.color, count(narrowed), project.areaId)
        },
        areaAllCount = count(filter.copy(areaId = null)),
        projectAllCount = count(filter.copy(projectId = null)),
        matchesNothing = filter.isActive && matching.isEmpty(),
    )
}

private fun WorkItem.toRow(today: IsoDate): TaskRow {
    val moved = effectiveDate
    val day = moved ?: schedule.date
    val planned = schedule.date
    val movedForward = planned != null && moved != null && planned < moved
    val dayDate = day?.let(IsoDate::parse)
    val done = status == TaskStatus.DONE
    return TaskRow(
        id = id,
        title = title,
        done = done,
        flagged = flagged,
        date = day,
        timeFrom = schedule.timeFrom,
        timeTo = schedule.timeTo,
        movedFrom = planned.takeIf { movedForward },
        projectTitle = project?.title,
        repeat = repeat,
        overdue = !done && dayDate != null && dayDate < today,
        missed = status == TaskStatus.MISSED,
    )
}
