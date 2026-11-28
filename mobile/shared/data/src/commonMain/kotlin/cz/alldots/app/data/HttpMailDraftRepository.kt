package cz.alldots.app.data

import cz.alldots.app.domain.MailAddress
import cz.alldots.app.domain.MailContact
import cz.alldots.app.domain.MailDraft
import cz.alldots.app.domain.MailDraftFields
import cz.alldots.app.domain.MailDraftMode
import cz.alldots.app.domain.MailDraftRepository
import cz.alldots.app.domain.MailOutcome
import cz.alldots.app.domain.MailPrefill
import cz.alldots.app.domain.MailSentDraft
import cz.alldots.app.domain.RepositoryResult
import cz.alldots.app.domain.map
import io.ktor.http.HttpMethod
import io.ktor.http.encodeURLPathPart
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObjectBuilder
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

private const val DRAFTS_PATH = "/api/mail/drafts"

/**
 * The drafts of `/api/mail/drafts*`. A person's send goes through the server as that person; the server refuses a
 * send that is not the person's own, and an agent's send is a proposal the person approves elsewhere. A refusal with a
 * known code is [MailOutcome.Refused].
 */
class HttpMailDraftRepository(private val api: AuthenticatedApi) : MailDraftRepository {

    override suspend fun create(
        fields: MailDraftFields,
        threadId: String?,
    ): RepositoryResult<MailOutcome<MailDraft>> {
        val body = buildJsonObject {
            putFields(fields)
            put("mode", MODE_NEW)
            if (threadId != null) put("threadId", threadId)
        }
        return api.send(HttpMethod.Post, DRAFTS_PATH, body = body.toString()).draftOutcome()
    }

    override suspend fun createPrefilled(prefill: MailPrefill): RepositoryResult<MailOutcome<MailDraft>> {
        val body = buildJsonObject {
            put("mailboxId", prefill.mailboxId)
            put("mode", prefill.mode.wire())
            put("sourceEmailId", prefill.sourceEmailId)
            put("body", prefill.body)
        }
        return api.send(HttpMethod.Post, DRAFTS_PATH, body = body.toString()).draftOutcome()
    }

    override suspend fun read(draftId: String): RepositoryResult<MailDraft> =
        api.send(HttpMethod.Get, draftPath(draftId)).decode<MailDraftDto>().map { it.toDomain() }

    override suspend fun update(
        draftId: String,
        version: String,
        fields: MailDraftFields,
    ): RepositoryResult<MailOutcome<MailDraft>> {
        val body = buildJsonObject {
            put("ifVersion", version)
            putFields(fields)
        }
        return api.send(HttpMethod.Patch, draftPath(draftId), body = body.toString()).draftOutcome()
    }

    override suspend fun discard(draftId: String): RepositoryResult<Unit> =
        api.send(HttpMethod.Delete, draftPath(draftId)).ignoreBody()

    override suspend fun send(draftId: String): RepositoryResult<MailOutcome<MailSentDraft>> =
        api.send(HttpMethod.Post, "${draftPath(draftId)}/send", body = "{}").mailOutcome {
            decode<MailSentDto>().map { MailSentDraft(it.emailId, it.threadId, it.mailbox.name) }
        }

    override suspend fun contacts(query: String, exclude: List<String>): RepositoryResult<List<MailContact>> {
        val parameters = listOfNotNull(
            "q" to query.trim(),
            "limit" to CONTACT_LIMIT,
            exclude.takeIf { it.isNotEmpty() }?.let { "exclude" to it.joinToString(",") },
        )
        return api.send(HttpMethod.Get, "/api/mail/contacts", parameters).decode<MailContactsDto>()
            .map { answer -> answer.contacts.map { MailContact(it.name, it.email, it.relationship) } }
    }

    private companion object {
        const val MODE_NEW = "new"
        const val CONTACT_LIMIT = "8"
    }
}

private fun draftPath(draftId: String) = "$DRAFTS_PATH/${draftId.encodeURLPathPart()}"

private fun ApiResponse.draftOutcome(): RepositoryResult<MailOutcome<MailDraft>> =
    mailOutcome { decode<MailDraftDto>().map { it.toDomain() } }

private fun MailDraftMode.wire(): String = when (this) {
    MailDraftMode.NEW -> "new"
    MailDraftMode.REPLY -> "reply"
    MailDraftMode.REPLY_ALL -> "replyAll"
    MailDraftMode.FORWARD -> "forward"
}

private fun JsonObjectBuilder.putFields(fields: MailDraftFields) {
    put("mailboxId", fields.mailboxId)
    put("from", fields.from)
    put("to", fields.to.toJson())
    put("cc", fields.cc.toJson())
    put("bcc", fields.bcc.toJson())
    put("subject", fields.subject)
    put("body", fields.body)
}

private fun List<MailAddress>.toJson() = JsonArray(
    map { recipient ->
        buildJsonObject {
            put("address", JsonPrimitive(recipient.address))
            put("name", JsonPrimitive(recipient.name))
        }
    },
)
