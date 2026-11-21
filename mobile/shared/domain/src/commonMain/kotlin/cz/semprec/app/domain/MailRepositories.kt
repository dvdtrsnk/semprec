package cz.semprec.app.domain

/**
 * The reads and thread actions of the mail screens. Every call answers with a [RepositoryResult]; a read mark, a flag
 * or a move the server refused for a known reason is [MailOutcome.Refused].
 */
interface MailRepository {
    suspend fun threads(query: MailThreadQuery): RepositoryResult<MailThreadPage>

    /** The area and project counts of the filter, narrowed by the selected area and project. */
    suspend fun facets(areaId: String?, projectId: String?): RepositoryResult<MailFacets>

    suspend fun summary(): RepositoryResult<MailSummary>

    suspend fun thread(threadId: String): RepositoryResult<MailThreadDetail>

    /** Marks the thread read or unread and answers whether it is unread afterwards. */
    suspend fun setRead(threadId: String, read: Boolean): RepositoryResult<MailOutcome<Boolean>>

    /** Flags or unflags the thread and answers whether it is flagged afterwards. */
    suspend fun setFlagged(threadId: String, flagged: Boolean): RepositoryResult<MailOutcome<Boolean>>

    suspend fun archive(threadId: String): RepositoryResult<MailOutcome<Unit>>

    suspend fun trash(threadId: String): RepositoryResult<MailOutcome<Unit>>

    suspend fun restore(threadId: String): RepositoryResult<MailOutcome<Unit>>

    /** Asks the server to make a task from the thread and to name it from the conversation. */
    suspend fun createTask(threadId: String): RepositoryResult<MailNamedRef>
}

/**
 * The drafts of the signed-in person. Sending goes through the server as the person; agents only propose. A draft
 * write or a send the server refused for a known reason is [MailOutcome.Refused].
 */
interface MailDraftRepository {
    suspend fun create(fields: MailDraftFields, threadId: String?): RepositoryResult<MailOutcome<MailDraft>>

    suspend fun createPrefilled(prefill: MailPrefill): RepositoryResult<MailOutcome<MailDraft>>

    suspend fun read(draftId: String): RepositoryResult<MailDraft>

    suspend fun update(
        draftId: String,
        version: String,
        fields: MailDraftFields,
    ): RepositoryResult<MailOutcome<MailDraft>>

    suspend fun discard(draftId: String): RepositoryResult<Unit>

    suspend fun send(draftId: String): RepositoryResult<MailOutcome<MailSentDraft>>

    /** People whose name or address contains [query], without the addresses in [exclude]. */
    suspend fun contacts(query: String, exclude: List<String>): RepositoryResult<List<MailContact>>
}

/** The mailboxes (accounts) of the signed-in person. */
interface MailboxRepository {
    suspend fun mailboxes(): RepositoryResult<List<MailAccount>>

    suspend fun mailbox(mailboxId: String): RepositoryResult<MailAccount>

    suspend fun folders(mailboxId: String): RepositoryResult<List<MailFolder>>

    suspend fun removalImpact(mailboxId: String): RepositoryResult<MailRemovalImpact>

    suspend fun remove(mailboxId: String): RepositoryResult<Unit>

    /** Connects a mailbox once the server checked the login; a login it refused is [MailConnectOutcome.Refused]. */
    suspend fun connect(account: MailPasswordAccount): RepositoryResult<MailConnectOutcome>

    /**
     * Signs a password mailbox in again with [password] and, when not `null`, [username]; `null` keeps the stored user
     * name. The server checks the login first, as for [connect].
     */
    suspend fun updatePassword(
        mailboxId: String,
        password: String,
        username: String?,
    ): RepositoryResult<MailConnectOutcome>

    suspend fun rename(mailboxId: String, name: String): RepositoryResult<Unit>

    suspend fun setConnectionLimit(mailboxId: String, limit: Int): RepositoryResult<Unit>
}
