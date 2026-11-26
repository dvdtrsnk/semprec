package cz.semprec.app.domain

import cz.semprec.app.core.FailureKind

/**
 * The edits of the sleep plans. A weekday is in at most one plan: writing a plan that holds a day another plan held
 * takes the day from that plan, which the server does.
 */
class EditSleepPlans(private val repository: SleepRepository) {
    /**
     * Writes [draft] as the plan [planId], or as a new plan named [newPlanName] when [planId] is `null`, in one write.
     * The draft must have a day of the week, both times a start time of the day and a night of an allowed length;
     * otherwise, or for a new plan without a name, the answer is a refusal. An id no plan has is not found.
     */
    suspend fun save(
        plans: List<SleepPlan>,
        planId: String?,
        newPlanName: String,
        draft: SleepScheduleDraft,
    ): RepositoryResult<Unit> {
        val times = draft.times.toClockTimes()
        val valid = draft.isComplete && SleepRules.WEEK.containsAll(draft.wakeDays)
        return when {
            !valid || times == null -> RepositoryResult.Failure(FailureKind.REJECTED)
            planId == null -> create(plans, newPlanName, draft, times)
            plans.none { it.id == planId } -> RepositoryResult.Failure(FailureKind.NOT_FOUND)
            else -> repository.updatePlan(
                planId,
                SleepPlanChange(wakeDays = draft.wakeDays, bed = times.first, wake = times.second, alarm = draft.alarm),
            )
        }
    }

    /** Deletes a plan unless it is the last one. */
    suspend fun delete(plans: List<SleepPlan>, planId: String): RepositoryResult<Unit> =
        when {
            plans.none { it.id == planId } -> RepositoryResult.Failure(FailureKind.NOT_FOUND)
            !SleepRules.canDeletePlan(plans) -> RepositoryResult.Failure(FailureKind.REJECTED)
            else -> repository.deletePlan(planId)
        }

    private suspend fun create(
        plans: List<SleepPlan>,
        name: String,
        draft: SleepScheduleDraft,
        times: Pair<ClockTime, ClockTime>,
    ): RepositoryResult<Unit> {
        if (name.isBlank()) return RepositoryResult.Failure(FailureKind.REJECTED)
        val plan = NewSleepPlan(
            name = name,
            wakeDays = draft.wakeDays,
            bed = times.first,
            wake = times.second,
            alarm = draft.alarm,
            position = (plans.maxOfOrNull { it.position } ?: -1) + 1,
        )
        return when (val created = repository.createPlan(plan)) {
            is RepositoryResult.Content -> RepositoryResult.Content(Unit)
            is RepositoryResult.Failure -> created
        }
    }
}

/** The two times as the clock times the server takes (a start time, never `24:00`), or `null` when one is not. */
internal fun SleepTimes.toClockTimes(): Pair<ClockTime, ClockTime>? {
    val bed = ClockTime.ofMinutes(bedMinutes)
    val wake = ClockTime.ofMinutes(wakeMinutes)
    if (bed == null || wake == null) return null
    return if (SleepRules.isSleepTime(bed) && SleepRules.isSleepTime(wake)) bed to wake else null
}
