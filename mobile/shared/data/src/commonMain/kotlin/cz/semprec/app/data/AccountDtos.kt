package cz.semprec.app.data

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonObject

/** `GET /api/account/summary`. */
@Serializable
internal data class AccountSummaryDto(
    val activeSessions: Int = 0,
    val mailAccountCount: Int = 0,
    val mailAccountsNeedingReauth: List<AccountReauthDto> = emptyList(),
    val trashItems: Int = 0,
    val trashDatabases: Int = 0,
    val problemCount: Int = 0,
    val aiCostMonthUsd: Double = 0.0,
)

@Serializable
internal data class AccountReauthDto(val id: String = "", val name: String = "")

/** `GET /api/auth/sessions`. */
@Serializable
internal data class AccountSessionsDto(val sessions: List<AccountSessionDto> = emptyList())

@Serializable
internal data class AccountSessionDto(
    val id: String,
    val current: Boolean = false,
    val platform: String? = null,
    val deviceKind: String? = null,
    val deviceName: String? = null,
    val createdAt: String = "",
    val lastSeenAt: String = "",
)

/** `GET` and `PATCH /api/notification-preferences`. */
@Serializable
internal data class AccountNotificationDto(
    val approvals: Boolean = true,
    val invites: Boolean = true,
    val reminders: Boolean = true,
    val problemsLevel: String = "critical",
    val problemsSummary: Boolean = true,
    val badgeApprovals: Boolean = true,
    val badgeInvites: Boolean = true,
    val badgeInbox: Boolean = false,
)

/** `GET /api/ai-usage`; only the parts the screen shows. */
@Serializable
internal data class AccountUsageReportDto(
    val accountStartedAt: String = "",
    val totalCostUsd: Double = 0.0,
    val estimated: Boolean = false,
    val dailyCostUsd: List<AccountDayCostDto> = emptyList(),
    val monthlyCostUsd: List<AccountMonthCostDto>? = null,
    val byModel: List<AccountModelCostDto> = emptyList(),
    val byOperation: List<AccountOperationCostDto> = emptyList(),
)

@Serializable
internal data class AccountDayCostDto(val day: String, val costUsd: Double = 0.0)

@Serializable
internal data class AccountMonthCostDto(val month: String, val costUsd: Double = 0.0)

@Serializable
internal data class AccountModelCostDto(
    val displayName: String = "",
    val model: String = "",
    val callCount: Int = 0,
    val costUsd: Double = 0.0,
    val inputTokens: Long? = null,
    val outputTokens: Long? = null,
    val audioSeconds: Double? = null,
)

@Serializable
internal data class AccountOperationCostDto(
    val label: String = "",
    val costUsd: Double = 0.0,
    val share: Double = 0.0,
    val callCount: Int = 0,
)

/** `GET /api/ai-usage/summary`. */
@Serializable
internal data class AccountUsageLimitsDto(
    val spentTodayUsd: Double = 0.0,
    val spentMonthUsd: Double = 0.0,
    val dailyCapUsd: Double? = null,
    val monthlyCapUsd: Double? = null,
    val exhausted: String? = null,
)

/** `GET /api/trash/items`. */
@Serializable
internal data class AccountTrashItemsDto(
    val items: List<AccountTrashRowDto> = emptyList(),
    val totalCount: Int = 0,
    val nextCursor: String? = null,
)

@Serializable
internal data class AccountTrashRowDto(
    val item: AccountTrashItemDto,
    val databaseId: String = "",
    val databaseKey: String? = null,
    val databaseName: String? = null,
    val page: AccountTrashPageDto? = null,
    val deletedAt: String = "",
    val daysLeft: Int = 0,
)

@Serializable
internal data class AccountTrashItemDto(
    val id: String,
    val properties: JsonObject = JsonObject(emptyMap()),
)

@Serializable
internal data class AccountTrashPageDto(val title: String = "")

/** `GET /api/trash/databases`. */
@Serializable
internal data class AccountTrashDatabasesDto(val databases: List<AccountTrashDatabaseDto> = emptyList())

@Serializable
internal data class AccountTrashDatabaseDto(
    val id: String,
    val name: String? = null,
    val liveItemCount: Int = 0,
    val archivedAt: String = "",
    val daysLeft: Int? = null,
)

/** `POST /api/trash/restore`. */
@Serializable
internal data class AccountRestoreDto(val results: List<AccountRestoreRowDto> = emptyList())

@Serializable
internal data class AccountRestoreRowDto(val id: String, val status: String = "")
