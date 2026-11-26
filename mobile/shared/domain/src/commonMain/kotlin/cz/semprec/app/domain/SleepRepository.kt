package cz.semprec.app.domain

/** The sleep plans, settings and night exceptions of the signed-in person. */
interface SleepRepository {
    /** The settings, the plans and, for a [night] that is not `null`, the resolved night of that evening. */
    suspend fun overview(night: CalendarDay?): RepositoryResult<SleepOverview>

    suspend fun updateSettings(itemId: String, change: SleepSettingsChange): RepositoryResult<Unit>

    /** Creates a plan and answers its id. The server takes the plan's wake days from the plans that held them. */
    suspend fun createPlan(plan: NewSleepPlan): RepositoryResult<String>

    suspend fun updatePlan(planId: String, change: SleepPlanChange): RepositoryResult<Unit>

    suspend fun deletePlan(planId: String): RepositoryResult<Unit>

    /** The resolved nights whose evenings are [from] to [to], both included, in order. */
    suspend fun nights(from: CalendarDay, to: CalendarDay): RepositoryResult<List<SleepNight>>

    /** Sets, changes or resets the exception of [night] and answers the resolved night, or `null` for none. */
    suspend fun changeNight(night: CalendarDay, change: SleepNightChange): RepositoryResult<SleepNight?>
}
