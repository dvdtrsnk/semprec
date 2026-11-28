package cz.alldots.app.data

import cz.alldots.app.domain.TaskScope
import kotlinx.serialization.json.JsonObject

/**
 * The filters of the three task lists. They mirror the backend's own definition of the Today list
 * (`backend/packages/data/src/tasks/todayView.ts`: `tasksVisibleFilter`, `tasksTodayFilter`), so that the app shows
 * the tasks the Overview counts.
 */
internal object TaskFilters {
    /** A task is visible once it is no longer hidden until later and is not completed inside an event. */
    private fun visible(): JsonObject = Filter.and(
        Filter.or(Filter.isEmpty("hiddenUntil"), Filter.dateRelative("hiddenUntil", "beforeNow")),
        RelationFilter.isEmpty("completedInEvent"),
    )

    private fun doneToday(): JsonObject = Filter.and(
        Filter.equals("status", "done"),
        Filter.dateRelative("completedOn", "today"),
    )

    /** What is on today: open on its day, still open from before, done today (or done on its day without a stamp). */
    private fun today(): JsonObject = Filter.or(
        Filter.and(Filter.notEquals("status", "done"), Filter.dateRelative("effectiveDate", "today")),
        Filter.and(Filter.equals("status", "notDone"), Filter.dateRelative("effectiveDate", "past")),
        doneToday(),
        Filter.and(
            Filter.equals("status", "done"),
            Filter.isEmpty("completedOn"),
            Filter.dateRelative("effectiveDate", "today"),
        ),
    )

    fun forScope(scope: TaskScope): JsonObject = Filter.and(
        visible(),
        when (scope) {
            TaskScope.TODAY -> today()
            TaskScope.PLANNED -> Filter.or(
                Filter.and(Filter.equals("status", "notDone"), Filter.isNotEmpty("effectiveDate")),
                doneToday(),
            )
            TaskScope.ALL -> Filter.or(Filter.equals("status", "notDone"), doneToday())
        },
    )
}
