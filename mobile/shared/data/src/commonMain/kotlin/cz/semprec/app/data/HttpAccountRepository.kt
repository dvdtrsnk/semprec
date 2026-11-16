package cz.semprec.app.data

import cz.semprec.app.core.AccountDeviceKind
import cz.semprec.app.core.AccountPlatform
import cz.semprec.app.domain.AccountDevice
import cz.semprec.app.domain.AccountRepository
import cz.semprec.app.domain.AccountSummary
import cz.semprec.app.domain.RepositoryResult
import cz.semprec.app.domain.map
import io.ktor.http.HttpMethod
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/**
 * The account calls: the profile figures of `GET /api/account/summary`, the signed-in sessions of
 * `GET /api/auth/sessions` with their revocation, and the language of `PATCH /api/account/profile`.
 */
class HttpAccountRepository(private val api: AuthenticatedApi) : AccountRepository {

    override suspend fun summary(): RepositoryResult<AccountSummary> =
        api.send(HttpMethod.Get, "/api/account/summary").decode<AccountSummaryDto>().map { dto ->
            AccountSummary(
                activeSessions = dto.activeSessions,
                mailAccountCount = dto.mailAccountCount,
                mailAccountsNeedingReauth = dto.mailAccountsNeedingReauth.size,
                trashItems = dto.trashItems,
                trashDatabases = dto.trashDatabases,
                problemCount = dto.problemCount,
                aiCostMonthUsd = dto.aiCostMonthUsd,
            )
        }

    override suspend fun devices(): RepositoryResult<List<AccountDevice>> =
        api.send(HttpMethod.Get, "/api/auth/sessions").decode<AccountSessionsDto>().map { dto ->
            dto.sessions.map { it.toDevice() }
        }

    override suspend fun revokeDevice(deviceId: String): RepositoryResult<Unit> =
        api.send(HttpMethod.Post, "/api/auth/sessions/$deviceId/revoke").ignoreBody()

    override suspend fun revokeOtherDevices(): RepositoryResult<Unit> =
        api.send(HttpMethod.Post, "/api/auth/sessions/revoke-others").ignoreBody()

    override suspend fun changeLocale(locale: String): RepositoryResult<Unit> =
        api.send(HttpMethod.Patch, "/api/account/profile", body = buildJsonObject { put("locale", locale) }.toString())
            .ignoreBody()
}

private fun AccountSessionDto.toDevice() = AccountDevice(
    id = id,
    current = current,
    platform = when (platform) {
        "web" -> AccountPlatform.WEB
        "ios" -> AccountPlatform.IOS
        "macos" -> AccountPlatform.MACOS
        else -> AccountPlatform.UNKNOWN
    },
    kind = when (deviceKind) {
        "iphone" -> AccountDeviceKind.IPHONE
        "ipad" -> AccountDeviceKind.IPAD
        "mac" -> AccountDeviceKind.MAC
        "browser" -> AccountDeviceKind.BROWSER
        else -> AccountDeviceKind.UNKNOWN
    },
    name = deviceName?.takeIf { it.isNotBlank() },
    createdAt = createdAt,
    lastSeenAt = lastSeenAt,
)
