package cz.alldots.app.domain

/** Where the drafts of the sleep editors start: a plan being edited, a new plan and a night. */
object SleepDrafts {
    /** The schedule [plan] has, fitted to the lengths the dial allows. */
    fun ofPlan(plan: SleepPlan): SleepScheduleDraft =
        SleepScheduleDraft(plan.wakeDays, SleepDial.fit(SleepTimes(plan.bed.minutes, plan.wake.minutes)), plan.alarm)

    /**
     * The schedule a new plan starts from: the weekdays no plan holds (none when every weekday has a plan, which
     * taking a day from another plan then fills), at the times of the first plan, else the server's base night, with
     * the alarm off.
     */
    fun newPlan(plans: List<SleepPlan>): SleepScheduleDraft {
        val first = plans.firstOrNull()
        val bed = first?.bed ?: SleepRules.BASE_BED
        val wake = first?.wake ?: SleepRules.BASE_WAKE
        val times = SleepDial.fit(SleepTimes(bed.minutes, wake.minutes))
        return SleepScheduleDraft(SleepRules.freeDays(plans), times, alarm = false)
    }

    /** The night of [night], or of the first plan, else the server's base night, fitted to the lengths the dial allows. */
    fun ofNight(night: SleepNight?, plans: List<SleepPlan>): SleepScheduleDraft {
        val times = night?.let { SleepTimes(it.bed.minutes, it.wake.minutes) }
            ?: plans.firstOrNull()?.let { SleepTimes(it.bed.minutes, it.wake.minutes) }
            ?: SleepTimes(SleepRules.BASE_BED.minutes, SleepRules.BASE_WAKE.minutes)
        val alarm = night?.alarm ?: plans.firstOrNull()?.alarm ?: false
        return SleepScheduleDraft(emptySet(), SleepDial.fit(times), alarm)
    }

    /** The weekdays held by the plans other than [planId], which a plan being edited can take over. */
    fun daysOfOtherPlans(plans: List<SleepPlan>, planId: String?): Set<Int> =
        plans.filter { it.id != planId }.flatMap { it.wakeDays }.toSet()
}
