package cz.semprec.app.data

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

/**
 * The mailboxes of `/api/mail/mailboxes*`: the list, one mailbox with its folders, the impact of a removal and the
 * removal itself, and a mailbox connected with a password. A name or a connection limit is an ordinary property of
 * the mailbox item, written through the item API with the version the item has. Gmail and Outlook mailboxes are
 * connected through a browser sign-in, which this repository does not do.
 */
class HttpMailboxRepository internal constructor(
    private val api: AuthenticatedApi,
    private val writes: ItemWrites,
    private val items: ItemsApi,
) : MailboxRepository {
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
        }
        return api.send(HttpMethod.Post, MAILBOXES_PATH, body = body.toString()).ignoreBody()
    }

    override suspend fun rename(mailboxId: String, name: String): RepositoryResult<Unit> =
        patch(mailboxId, buildJsonObject { put(NAME_KEY, name) })

    override suspend fun setConnectionLimit(mailboxId: String, limit: Int): RepositoryResult<Unit> =
        patch(mailboxId, buildJsonObject { put(CONNECTION_LIMIT_KEY, limit) })

    private suspend fun patch(mailboxId: String, properties: JsonObject) =
        items.get(mailboxId).then { item -> writes.patch(mailboxId, properties, item.version) }.map { }
}

private fun mailboxPath(mailboxId: String) = "$MAILBOXES_PATH/${mailboxId.encodeURLPathPart()}"
