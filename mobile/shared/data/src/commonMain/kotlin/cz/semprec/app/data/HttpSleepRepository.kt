package cz.semprec.app.data

import cz.semprec.app.core.FailureKind
import cz.semprec.app.domain.CalendarDay
import cz.semprec.app.domain.NewSleepPlan
import cz.semprec.app.domain.RepositoryResult
import cz.semprec.app.domain.SleepNight
import cz.semprec.app.domain.SleepNightChange
import cz.semprec.app.domain.SleepOverview
import cz.semprec.app.domain.SleepPlanChange
import cz.semprec.app.domain.SleepRepository
import cz.semprec.app.domain.SleepSettingsChange
import io.ktor.http.HttpMethod
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

private const val SETTINGS_KEY = "sleepSettings"
private const val PLANS_KEY = "sleepPlans"
private const val EMPTY_JSON_OBJECT = "{}"
/** The ids of the sleep databases of the tenant, found once through `GET /api/schema` by their canonical keys. */
private data class SleepDatabases(val settings: String, val plans: String)

/**
 * The sleep data over the backend: the resolved nights from `GET /api/sleep/nights`, a night's exception from
 * `PUT /api/sleep/nights/:night`, and the settings and plans through the generic item API (`/api/schema` to find
 * the databases, then query, create, patch and delete). A patch reads the item first, because the server wants the
 * version the change is made against.
 */
class HttpSleepRepository(private val api: AuthenticatedApi) : SleepRepository {
    private var databases: SleepDatabases? = null

    override suspend fun overview(night: CalendarDay?): RepositoryResult<SleepOverview> =
        when (val found = databaseIds()) {
            is RepositoryResult.Failure -> found
            is RepositoryResult.Content -> readOverview(found.value, night)
        }

    override suspend fun updateSettings(itemId: String, change: SleepSettingsChange): RepositoryResult<Unit> =
        patch(itemId, change.toProperties())

    override suspend fun createPlan(plan: NewSleepPlan): RepositoryResult<String> =
        when (val found = databaseIds()) {
            is RepositoryResult.Failure -> found
            is RepositoryResult.Content -> {
                val properties = buildJsonObject {
                    put("name", plan.name)
                    put("wakeDays", plan.wakeDays.toWire())
                    put("bedTime", plan.bed.toString())
                    put("wakeTime", plan.wake.toString())
                    put("alarm", plan.alarm)
                    put("position", plan.position)
                }
                val body = ApiJson.encodeToString(SleepCreateRequest(properties))
                val response = api.send(HttpMethod.Post, "/api/databases/${found.value.plans}/items", body = body)
                when (val created = response.decode<SleepStoredItem>()) {
                    is RepositoryResult.Failure -> created
                    is RepositoryResult.Content -> RepositoryResult.Content(created.value.id)
                }
            }
        }

    override suspend fun updatePlan(planId: String, change: SleepPlanChange): RepositoryResult<Unit> =
        patch(planId, change.toProperties())

    override suspend fun deletePlan(planId: String): RepositoryResult<Unit> =
        api.send(HttpMethod.Delete, "/api/items/$planId").ignoreBody()

    override suspend fun changeNight(night: CalendarDay, change: SleepNightChange): RepositoryResult<SleepNight?> {
        val response = api.send(HttpMethod.Put, "/api/sleep/nights/$night", body = change.toBody())
        return when (val envelope = response.decode<SleepNightEnvelope>()) {
            is RepositoryResult.Failure -> envelope
            is RepositoryResult.Content -> envelope.value.night.toResult()
        }
    }

    private suspend fun databaseIds(): RepositoryResult<SleepDatabases> {
        val known = databases
        if (known != null) return RepositoryResult.Content(known)
        return when (val schema = api.send(HttpMethod.Get, "/api/schema").decode<SleepSchemaResponse>()) {
            is RepositoryResult.Failure -> schema
            is RepositoryResult.Content -> {
                val byKey = schema.value.databases.filter { it.key != null }.associate { it.key to it.databaseId }
                val settings = byKey[SETTINGS_KEY]
                val plans = byKey[PLANS_KEY]
                if (settings == null || plans == null) {
                    RepositoryResult.Failure(FailureKind.NOT_FOUND)
                } else {
                    RepositoryResult.Content(SleepDatabases(settings, plans).also { databases = it })
                }
            }
        }
    }

    private suspend fun readOverview(ids: SleepDatabases, night: CalendarDay?): RepositoryResult<SleepOverview> {
        val settings = queryItems(ids.settings).mapSettings()
        val plans = queryItems(ids.plans).mapPlans()
        val resolved = if (night == null) RepositoryResult.Content(null) else readNight(night)
        return when {
            settings is RepositoryResult.Failure -> settings
            plans is RepositoryResult.Failure -> plans
            resolved is RepositoryResult.Failure -> resolved
            settings is RepositoryResult.Content && plans is RepositoryResult.Content &&
                resolved is RepositoryResult.Content -> RepositoryResult.Content(
                SleepOverview(settings.value, plans.value, resolved.value),
            )
            else -> RepositoryResult.Failure(FailureKind.INVALID_DATA)
        }
    }

    private suspend fun queryItems(databaseId: String): RepositoryResult<List<SleepStoredItem>> {
        val response = api.send(HttpMethod.Post, "/api/databases/$databaseId/query", body = EMPTY_JSON_OBJECT)
        return when (val list = response.decode<SleepItemList>()) {
            is RepositoryResult.Failure -> list
            is RepositoryResult.Content -> RepositoryResult.Content(list.value.items)
        }
    }

    private suspend fun readNight(night: CalendarDay): RepositoryResult<SleepNight?> {
        val query = listOf("from" to night.toString(), "to" to night.toString())
        val response = api.send(HttpMethod.Get, "/api/sleep/nights", query = query)
        return when (val nights = response.decode<SleepNightsResponse>()) {
            is RepositoryResult.Failure -> nights
            is RepositoryResult.Content -> nights.value.nights.firstOrNull().toResult()
        }
    }

    private suspend fun patch(itemId: String, properties: JsonObject): RepositoryResult<Unit> =
        when (val current = api.send(HttpMethod.Get, "/api/items/$itemId").decode<SleepStoredItem>()) {
            is RepositoryResult.Failure -> current
            is RepositoryResult.Content -> {
                val body = ApiJson.encodeToString(SleepPatchRequest(properties, current.value.updatedAt))
                api.send(HttpMethod.Patch, "/api/items/$itemId", body = body).ignoreBody()
            }
        }
}
