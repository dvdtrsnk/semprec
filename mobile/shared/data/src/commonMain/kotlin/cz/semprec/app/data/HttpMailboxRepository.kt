package cz.semprec.app.data

import cz.semprec.app.domain.InternetAccount
import cz.semprec.app.domain.InternetAccountRepository
import cz.semprec.app.domain.InternetService
import cz.semprec.app.domain.MailAccount
import cz.semprec.app.domain.MailFolder
import cz.semprec.app.domain.MailPasswordAccount
import cz.semprec.app.domain.MailPasswordProvider
import cz.semprec.app.domain.MailRemovalImpact
import cz.semprec.app.domain.MailboxRepository
import cz.semprec.app.domain.RepositoryResult
import cz.semprec.app.domain.map
import cz.semprec.app.domain.then
import io.ktor.http.HttpMethod
import io.ktor.http.encodeURLPathPart
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

private const val MAILBOXES_PATH = "/api/mail/mailboxes"
private const val NAME_KEY = "name"
private const val CONNECTION_LIMIT_KEY = "connectionLimit"
private const val MAIL_ENABLED_KEY = "mailEnabled"
private const val CALENDARS_ENABLED_KEY = "calendarsEnabled"

/**
 * The server checks a new mailbox's IMAP and then its SMTP server before it answers, each on up to two ports that may
 * each take 45 s to time out, so the request waits for that instead of reporting the Semprec server unreachable.
 */
private const val CONNECT_TIMEOUT_MILLIS = 200_000L

/**
 * The mailboxes of `/api/mail/mailboxes*`, which are also the internet accounts: the list, one mailbox with its
 * folders, the impact of a removal and the removal itself, and a mailbox connected with a password. A name, a
 * connection limit and the Mail and Calendars switches are ordinary properties of the mailbox item, written through
 * the item API with the version the item has. Gmail and Outlook mailboxes are connected through a browser sign-in,
 * which this repository does not do.
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

    override suspend fun connect(account: MailPasswordAccount): RepositoryResult<Unit> {
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
        ).ignoreBody()
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

    private suspend fun patch(mailboxId: String, properties: JsonObject) =
        items.get(mailboxId).then { item -> writes.patch(mailboxId, properties, item.version) }.map { }
}

private fun mailboxPath(mailboxId: String) = "$MAILBOXES_PATH/${mailboxId.encodeURLPathPart()}"
