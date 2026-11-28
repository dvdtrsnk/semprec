package cz.alldots.app.data

import cz.alldots.app.core.FailureKind
import cz.alldots.app.domain.InternetAccount
import cz.alldots.app.domain.InternetAccountRepository
import cz.alldots.app.domain.InternetService
import cz.alldots.app.domain.MailAccount
import cz.alldots.app.domain.MailConnectOutcome
import cz.alldots.app.domain.MailConnectRefusal
import cz.alldots.app.domain.MailFolder
import cz.alldots.app.domain.MailPasswordAccount
import cz.alldots.app.domain.MailPasswordProvider
import cz.alldots.app.domain.MailRemovalImpact
import cz.alldots.app.domain.MailboxRepository
import cz.alldots.app.domain.OAuthOutcome
import cz.alldots.app.domain.OAuthProvider
import cz.alldots.app.domain.OAuthSignIn
import cz.alldots.app.domain.RepositoryResult
import cz.alldots.app.domain.map
import cz.alldots.app.domain.then
import io.ktor.http.HttpMethod
import io.ktor.http.encodeURLPathPart
import io.ktor.http.parseUrl
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonObjectBuilder
import kotlinx.serialization.json.add
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray

private const val MAILBOXES_PATH = "/api/mail/mailboxes"
private const val NAME_KEY = "name"
private const val CONNECTION_LIMIT_KEY = "connectionLimit"
private const val MAIL_ENABLED_KEY = "mailEnabled"
private const val CALENDARS_ENABLED_KEY = "calendarsEnabled"

/** Where the server sends the browser back after a sign-in that the app started (`redirectTarget: "app"`). */
private const val OAUTH_CALLBACK_SCHEME = "alldots"
private const val OAUTH_CALLBACK_HOST = "oauth"

/**
 * The server checks a mailbox's IMAP and then its SMTP server before it connects it or signs it in again, each on up
 * to two ports that may each take 45 s to time out, so the request waits for that instead of reporting the Alldots
 * server unreachable.
 */
private const val CONNECT_TIMEOUT_MILLIS = 200_000L

/**
 * The mailboxes of `/api/mail/mailboxes*`, which are also the internet accounts: the list, one mailbox with its
 * folders, the impact of a removal and the removal itself, and a mailbox connected or signed in again with a
 * password. A name, a connection limit and the Mail and Calendars switches are ordinary properties of the mailbox
 * item, written through the item API with the version the item has. Gmail and Outlook mailboxes sign in in a
 * browser: this repository starts the sign-in with the server, which answers the provider page and later sends the
 * browser back to `alldots://oauth`, and hands the code from there to the server.
 */
class HttpMailboxRepository internal constructor(
    private val api: AuthenticatedApi,
    private val writes: ItemWrites,
    private val items: ItemsApi,
) : MailboxRepository, InternetAccountRepository {
    constructor(api: AuthenticatedApi) : this(api, ItemWrites(api), ItemsApi(api))

    override suspend fun mailboxes(): RepositoryResult<List<MailAccount>> =
        api.send(HttpMethod.Get, MAILBOXES_PATH).decode<MailMailboxListDto>()
            .map { list -> list.mailboxes.map { it.toDomain() } }

    override suspend fun mailbox(mailboxId: String): RepositoryResult<MailAccount> =
        api.send(HttpMethod.Get, mailboxPath(mailboxId)).decode<MailMailboxDto>().map { it.toDomain() }

    override suspend fun folders(mailboxId: String): RepositoryResult<List<MailFolder>> =
        api.send(HttpMethod.Get, "${mailboxPath(mailboxId)}/folders").decode<List<MailFolderDto>>()
            .map { list -> list.map { it.toDomain() } }

    override suspend fun removalImpact(mailboxId: String): RepositoryResult<MailRemovalImpact> =
        api.send(HttpMethod.Get, "${mailboxPath(mailboxId)}/removal-impact").decode<MailRemovalImpactDto>()
            .map { it.toDomain() }

    override suspend fun remove(mailboxId: String): RepositoryResult<Unit> =
        api.send(HttpMethod.Delete, mailboxPath(mailboxId)).ignoreBody()

    override suspend fun connect(account: MailPasswordAccount): RepositoryResult<MailConnectOutcome> {
        val body = buildJsonObject {
            put(
                "provider",
                when (account.provider) {
                    MailPasswordProvider.ICLOUD -> "icloud"
                    MailPasswordProvider.GENERIC -> "generic"
                },
            )
            put("address", account.address)
            put("password", account.password)
            account.imapHost?.let { put("imapHost", it) }
            account.smtpHost?.let { put("smtpHost", it) }
            account.caldavUrl?.let { put("caldavUrl", it) }
        }
        return api.send(
            HttpMethod.Post,
            MAILBOXES_PATH,
            body = body.toString(),
            requestTimeoutMillis = CONNECT_TIMEOUT_MILLIS,
        ).connectOutcome()
    }

    override suspend fun updatePassword(
        mailboxId: String,
        password: String,
        username: String?,
    ): RepositoryResult<MailConnectOutcome> {
        val body = buildJsonObject {
            put("password", password)
            username?.let { put("username", it) }
        }
        return api.send(
            HttpMethod.Put,
            "${mailboxPath(mailboxId)}/password",
            body = body.toString(),
            requestTimeoutMillis = CONNECT_TIMEOUT_MILLIS,
        ).connectOutcome()
    }

    override suspend fun rename(mailboxId: String, name: String): RepositoryResult<Unit> =
        patch(mailboxId, buildJsonObject { put(NAME_KEY, name) })

    override suspend fun setConnectionLimit(mailboxId: String, limit: Int): RepositoryResult<Unit> =
        patch(mailboxId, buildJsonObject { put(CONNECTION_LIMIT_KEY, limit) })

    override suspend fun accounts(): RepositoryResult<List<InternetAccount>> =
        api.send(HttpMethod.Get, MAILBOXES_PATH).decode<MailMailboxListDto>()
            .map { list -> list.mailboxes.map { it.toInternetAccount() } }

    override suspend fun account(accountId: String): RepositoryResult<InternetAccount> =
        api.send(HttpMethod.Get, mailboxPath(accountId)).decode<MailMailboxDto>().map { it.toInternetAccount() }

    override suspend fun setServiceEnabled(
        accountId: String,
        service: InternetService,
        enabled: Boolean,
    ): RepositoryResult<Unit> {
        val key = when (service) {
            InternetService.MAIL -> MAIL_ENABLED_KEY
            InternetService.CALENDARS -> CALENDARS_ENABLED_KEY
        }
        return patch(accountId, buildJsonObject { put(key, enabled) })
    }

    override suspend fun syncCalendars(accountId: String): RepositoryResult<Unit> =
        api.send(HttpMethod.Post, "/api/accounts/${accountId.encodeURLPathPart()}/calendars/sync").ignoreBody()

    override suspend fun startSignIn(
        provider: OAuthProvider,
        services: Set<InternetService>,
    ): RepositoryResult<OAuthSignIn> {
        val body = buildJsonObject {
            put(
                "provider",
                when (provider) {
                    OAuthProvider.GOOGLE -> "gmail"
                    OAuthProvider.MICROSOFT -> "outlook"
                },
            )
            putServices(services + InternetService.MAIL)
            put("redirectTarget", "app")
        }
        return api.send(HttpMethod.Post, "$MAILBOXES_PATH/oauth/start", body = body.toString()).signIn()
    }

    override suspend fun startReauthorization(
        accountId: String,
        services: Set<InternetService>,
    ): RepositoryResult<OAuthSignIn> {
        val body = buildJsonObject {
            if (services.isNotEmpty()) putServices(services + InternetService.MAIL)
            put("redirectTarget", "app")
        }
        return api.send(HttpMethod.Post, "${mailboxPath(accountId)}/reauthorize", body = body.toString()).signIn()
    }

    override suspend fun finishSignIn(signIn: OAuthSignIn, callbackUrl: String): RepositoryResult<OAuthOutcome> {
        val parameters = parseUrl(callbackUrl)
            ?.takeIf { it.protocol.name == OAUTH_CALLBACK_SCHEME && it.host == OAUTH_CALLBACK_HOST }
            ?.parameters
            ?.takeIf { it["state"] == signIn.state }
        val code = parameters?.get("code")?.takeIf { it.isNotEmpty() }
        return when {
            parameters == null -> RepositoryResult.Failure(FailureKind.INVALID_DATA)
            parameters["error"] != null -> RepositoryResult.Content(OAuthOutcome.Declined)
            code == null -> RepositoryResult.Failure(FailureKind.INVALID_DATA)
            else -> {
                val body = buildJsonObject {
                    put("state", signIn.state)
                    put("code", code)
                }
                api.send(HttpMethod.Post, "$MAILBOXES_PATH/oauth/complete", body = body.toString()).oauthOutcome()
            }
        }
    }

    private suspend fun patch(mailboxId: String, properties: JsonObject) =
        items.get(mailboxId).then { item -> writes.patch(mailboxId, properties, item.version) }.map { }
}

private fun mailboxPath(mailboxId: String) = "$MAILBOXES_PATH/${mailboxId.encodeURLPathPart()}"

private const val TOO_MANY_REQUESTS = 429

/** The refusal codes of the password routes, as the server names them. */
private val REFUSALS = mapOf(
    "mail_auth_failed" to MailConnectRefusal.WRONG_CREDENTIALS,
    "mail_app_password_required" to MailConnectRefusal.APP_PASSWORD_REQUIRED,
    "mail_server_unreachable" to MailConnectRefusal.SERVER_UNREACHABLE,
    "mail_tls_failed" to MailConnectRefusal.TLS_FAILED,
    "caldav_auth_failed" to MailConnectRefusal.CALDAV_REFUSED,
    "caldav_server_unreachable" to MailConnectRefusal.CALDAV_UNREACHABLE,
    "caldav_server_invalid" to MailConnectRefusal.CALDAV_UNREACHABLE,
    "provider_account_already_connected" to MailConnectRefusal.ALREADY_CONNECTED,
    "rate_limited" to MailConnectRefusal.RATE_LIMITED,
)

/**
 * The answer of a checked password login: a success connected the mailbox the answered item is, a refusal with a
 * known code (or a `429`, which these routes answer only when rate limited) is [MailConnectOutcome.Refused], and any
 * other failure stays its [FailureKind].
 */
private fun ApiResponse.connectOutcome(): RepositoryResult<MailConnectOutcome> = when (this) {
    is ApiResponse.Success -> decode<MailConnectedItemDto>().map { MailConnectOutcome.Connected(it.id) }
    is ApiResponse.Failure -> {
        val refusal = REFUSALS[errorCode()] ?: MailConnectRefusal.RATE_LIMITED.takeIf { status == TOO_MANY_REQUESTS }
        if (refusal == null) {
            RepositoryResult.Failure(kind)
        } else {
            RepositoryResult.Content(MailConnectOutcome.Refused(refusal))
        }
    }
}

/** The refusal codes of the browser sign-in's completion, as the server names them. */
private val OAUTH_REFUSALS = mapOf(
    "provider_account_already_connected" to MailConnectRefusal.ALREADY_CONNECTED,
    "mail_reauth_wrong_account" to MailConnectRefusal.WRONG_ACCOUNT,
    "mail_consent_missing" to MailConnectRefusal.MAIL_CONSENT_MISSING,
)

/**
 * The answer of a browser sign-in's completion: a success connected the mailbox it names, a refusal with a known code
 * is [OAuthOutcome.Refused], and any other failure stays its [FailureKind].
 */
private fun ApiResponse.oauthOutcome(): RepositoryResult<OAuthOutcome> = when (this) {
    is ApiResponse.Success -> decode<MailOauthCompleteDto>().map { OAuthOutcome.Connected(it.mailboxId) }
    is ApiResponse.Failure -> {
        val refusal = OAUTH_REFUSALS[errorCode()]
        if (refusal == null) RepositoryResult.Failure(kind) else RepositoryResult.Content(OAuthOutcome.Refused(refusal))
    }
}

/** In the order the server lists them; the caller decides whether Mail is among them. */
private fun JsonObjectBuilder.putServices(services: Set<InternetService>) {
    putJsonArray("services") {
        if (InternetService.MAIL in services) add("mail")
        if (InternetService.CALENDARS in services) add("calendars")
    }
}

/** The provider page of a started sign-in, with the state it carries; a page without one is unreadable. */
private fun ApiResponse.signIn(): RepositoryResult<OAuthSignIn> =
    decode<MailOauthAuthorizeDto>().then { dto ->
        val state = parseUrl(dto.authorizeUrl)?.parameters?.get("state")?.takeIf { it.isNotEmpty() }
        if (state == null) {
            RepositoryResult.Failure(FailureKind.INVALID_DATA)
        } else {
            RepositoryResult.Content(OAuthSignIn(dto.authorizeUrl, state))
        }
    }

/** The item a password route answers with, the mailbox connected or signed in again; only its id is read. */
@Serializable
private data class MailConnectedItemDto(val id: String)
