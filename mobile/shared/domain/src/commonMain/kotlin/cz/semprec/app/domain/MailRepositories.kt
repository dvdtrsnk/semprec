package cz.semprec.app.domain

/** The reads and thread actions of the mail screens. Every call answers with a [RepositoryResult]. */
interface MailRepository {
    suspend fun threads(query: MailThreadQuery): RepositoryResult<MailThreadPage>

    /** The area and project counts of the filter, narrowed by the selected area and project. */
    suspend fun facets(areaId: String?, projectId: String?): RepositoryResult<MailFacets>

    suspend fun summary(): RepositoryResult<MailSummary>

    suspend fun thread(threadId: String): RepositoryResult<MailThreadDetail>

    /** Marks the thread read or unread and answers whether it is unread afterwards. */
    suspend fun setRead(threadId: String, read: Boolean): RepositoryResult<Boolean>

    /** Flags or unflags the thread and answers whether it is flagged afterwards. */
    suspend fun setFlagged(threadId: String, flagged: Boolean): RepositoryResult<Boolean>

    suspend fun archive(threadId: String): RepositoryResult<Unit>

    suspend fun trash(threadId: String): RepositoryResult<Unit>

    suspend fun restore(threadId: String): RepositoryResult<Unit>

    /** Asks the server to make a task from the thread and to name it from the conversation. */
    suspend fun createTask(threadId: String): RepositoryResult<MailNamedRef>
}

/** The drafts of the signed-in person. Sending goes through the server as the person; agents only propose. */
interface MailDraftRepository {
    suspend fun create(fields: MailDraftFields, threadId: String?): RepositoryResult<MailDraft>

    suspend fun createPrefilled(prefill: MailPrefill): RepositoryResult<MailDraft>

    suspend fun read(draftId: String): RepositoryResult<MailDraft>

    suspend fun update(draftId: String, version: String, fields: MailDraftFields): RepositoryResult<MailDraft>

    suspend fun discard(draftId: String): RepositoryResult<Unit>

    suspend fun send(draftId: String): RepositoryResult<MailSentDraft>

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

    suspend fun connect(account: MailPasswordAccount): RepositoryResult<Unit>

    suspend fun rename(mailboxId: String, name: String): RepositoryResult<Unit>

    suspend fun setConnectionLimit(mailboxId: String, limit: Int): RepositoryResult<Unit>
}
