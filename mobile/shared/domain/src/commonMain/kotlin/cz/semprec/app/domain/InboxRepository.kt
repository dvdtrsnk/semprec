package cz.semprec.app.domain

/** The item an approved card created or changed, as the answer of the approval names it. */
data class InboxOutcome(val label: String, val databaseKey: String?, val itemId: String?)

/**
 * The Inbox of the signed-in person: the cards Semp and the captures wait on, and the changes of their proposals.
 * Every write carries the card's [InboxCard.version], so a card that changed meanwhile is refused instead of
 * overwritten.
 */
interface InboxRepository {
    /** The open cards in the order of the stack, with the number that waits for a decision. */
    suspend fun stack(): RepositoryResult<InboxStack>

    /** How many cards wait for a decision (the badge of the overview). */
    suspend fun count(): RepositoryResult<Int>

    /** The Inbox item types a card that needs clarification can become. */
    suspend fun types(): RepositoryResult<List<InboxType>>

    /** The choices of the item picker [source] (`project`, `area`, `page`, ...) of [card]. */
    suspend fun options(card: InboxCard, source: String): RepositoryResult<List<InboxChoice>>

    /** Saves [edit] on the card; answers the card as the server holds it afterwards. */
    suspend fun edit(card: InboxCard, edit: InboxEdit): RepositoryResult<InboxCard>

    /** Replaces the proposal of the card as [revision] says; answers the card as the server holds it afterwards. */
    suspend fun revise(card: InboxCard, revision: InboxRevision): RepositoryResult<InboxCard>

    /** Returns the card to the last proposal of Semp, dropping the person's values. */
    suspend fun reset(card: InboxCard): RepositoryResult<InboxCard>

    /** Asks Semp to compute the card again. */
    suspend fun recompute(card: InboxCard): RepositoryResult<Unit>
}

/** The decisions on the cards of the Inbox; each carries the version of the card it was read at. */
interface InboxDecisions {
    /** Approves a proposal: writes what it proposes. [credential] is the secret an MCP server card is approved with. */
    suspend fun confirm(card: InboxCard, credential: String?): RepositoryResult<InboxOutcome?>

    /** Discards a proposal without writing anything. */
    suspend fun reject(card: InboxCard): RepositoryResult<Unit>

    /** Approves or rejects the request of Semp that [card] is. */
    suspend fun decideApproval(card: InboxCard, approve: Boolean): RepositoryResult<Unit>

    /** Gives the capture the card was made from another type; Semp then proposes again. */
    suspend fun changeType(card: InboxCard, typeId: String): RepositoryResult<Unit>

    /** Returns a card that was decided on to the stack; a confirmed one is reversed by the server. */
    suspend fun reopen(cardId: String): RepositoryResult<Unit>
}
