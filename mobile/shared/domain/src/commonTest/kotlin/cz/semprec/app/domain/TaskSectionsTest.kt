package cz.semprec.app.domain

import cz.semprec.app.core.ItemKind
import cz.semprec.app.core.ProjectRef
import cz.semprec.app.core.TaskSectionKind
import cz.semprec.app.core.TaskStatus
import cz.semprec.app.core.TasksTab
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class TaskSectionsTest {
    private val today = checkNotNull(IsoDate.parse("2026-10-16"))

    private fun task(
        id: String,
        date: String?,
        from: String? = null,
        effective: String? = date,
        status: TaskStatus = TaskStatus.NOT_DONE,
        project: ProjectRef? = null,
        flagged: Boolean = false,
    ) = WorkItem(
        kind = ItemKind.TASK,
        id = id,
        version = "v",
        title = id,
        schedule = Schedule(date, from, null),
        status = status,
        effectiveDate = effective,
        project = project,
        flagged = flagged,
    )

    @Test fun `a task is in the group of its effective day`() {
        assertEquals(TaskSectionKind.LATE, TaskSections.kindOf(task("a", "2026-10-13"), today))
        assertEquals(TaskSectionKind.TODAY, TaskSections.kindOf(task("a", "2026-10-16"), today))
        assertEquals(TaskSectionKind.TOMORROW, TaskSections.kindOf(task("a", "2026-10-17"), today))
        assertEquals(TaskSectionKind.WEEK, TaskSections.kindOf(task("a", "2026-10-18"), today))
        assertEquals(TaskSectionKind.WEEK, TaskSections.kindOf(task("a", "2026-10-25"), today))
        assertEquals(TaskSectionKind.LATER, TaskSections.kindOf(task("a", "2026-10-26"), today))
        assertEquals(TaskSectionKind.NONE, TaskSections.kindOf(task("a", null, effective = null), today))
    }

    @Test fun `the server moved day wins over the planned day and a missing one falls back to it`() {
        val moved = task("a", "2026-10-13", effective = "2026-10-16")
        assertEquals(TaskSectionKind.TODAY, TaskSections.kindOf(moved, today))
        assertEquals(TaskSectionKind.TOMORROW, TaskSections.kindOf(task("a", "2026-10-17", effective = null), today))
    }

    @Test fun `a task done today stays in today whatever day it was planned for`() {
        val done = task("a", "2026-10-13", effective = "2026-10-13", status = TaskStatus.DONE)
        assertEquals(TaskSectionKind.TODAY, TaskSections.kindOf(done, today))
    }

    @Test fun `each tab shows its own groups and today is always one of them`() {
        assertEquals(listOf(TaskSectionKind.LATE, TaskSectionKind.TODAY), TaskSections.kinds(TasksTab.TODAY))
        assertEquals(5, TaskSections.kinds(TasksTab.PLANNED).size)
        assertTrue(TaskSectionKind.NONE in TaskSections.kinds(TasksTab.ALL))
        assertFalse(TaskSectionKind.NONE in TaskSections.kinds(TasksTab.PLANNED))
        val sections = TaskSections.group(emptyList(), today, TasksTab.TODAY)
        assertEquals(listOf(TaskSectionKind.LATE, TaskSectionKind.TODAY), sections.map { it.kind })
        assertTrue(sections.all { it.items.isEmpty() })
    }

    @Test fun `a group is ordered by day then start time then title`() {
        val items = listOf(
            task("c", "2026-10-16", from = "9:00"),
            task("b", "2026-10-16", from = "14:00"),
            task("a", "2026-10-16"),
            task("d", "2026-10-16", from = "09:00"),
            task("e", "2026-10-13", effective = "2026-10-13"),
        )

        val sections = TaskSections.group(items, today, TasksTab.TODAY)

        assertEquals(listOf("e"), sections[0].items.map { it.id })
        assertEquals(listOf("c", "d", "b", "a"), sections[1].items.map { it.id })
    }

    @Test fun `tasks of a group the tab does not show drop out`() {
        val items = listOf(task("a", "2026-10-17"), task("b", null, effective = null))
        assertTrue(TaskSections.group(items, today, TasksTab.TODAY).all { it.items.isEmpty() })
        val planned = TaskSections.group(items, today, TasksTab.PLANNED)
        assertEquals(listOf("a"), planned.flatMap { section -> section.items.map { it.id } })
    }

    @Test fun `the filter narrows by project and flag`() {
        val work = ProjectRef("p1", "Semprec iOS")
        val home = ProjectRef("p2", "Koupelna")
        val inWork = task("a", null, project = work, flagged = true)
        val inHome = task("b", null, project = home)
        val none = task("c", null)
        val all = listOf(inWork, inHome, none)

        assertFalse(TaskFilter().isActive)
        assertTrue(TaskFilter().matches(none))
        assertEquals(listOf(inHome), all.filter(TaskFilter(projectId = "p2")::matches))
        assertEquals(listOf(inWork), all.filter(TaskFilter(flaggedOnly = true)::matches))
        assertEquals(emptyList(), all.filter(TaskFilter(projectId = "p2", flaggedOnly = true)::matches))
        assertTrue(TaskFilter(projectId = "p2").isActive)
        assertTrue(TaskFilter(flaggedOnly = true).isActive)
    }
}
