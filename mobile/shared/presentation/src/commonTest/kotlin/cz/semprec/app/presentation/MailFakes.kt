package cz.semprec.app.presentation

import cz.semprec.app.core.FailureKind
import cz.semprec.app.domain.CalendarSyncStatus
import cz.semprec.app.domain.InternetAccount
import cz.semprec.app.domain.InternetAccountRepository
import cz.semprec.app.domain.InternetService
import cz.semprec.app.domain.MailAccount
import cz.semprec.app.domain.MailAddress
import cz.semprec.app.domain.MailConnectOutcome
import cz.semprec.app.domain.MailContact
import cz.semprec.app.domain.MailDraft
import cz.semprec.app.domain.MailDraftFields
import cz.semprec.app.domain.MailDraftMode
import cz.semprec.app.domain.MailDraftRepository
import cz.semprec.app.domain.MailFacetOption
import cz.semprec.app.domain.MailFacets
import cz.semprec.app.domain.MailFolder
import cz.semprec.app.domain.MailMessage
import cz.semprec.app.domain.MailNamedRef
import cz.semprec.app.domain.MailPasswordAccount
import cz.semprec.app.domain.MailPrefill
import cz.semprec.app.domain.MailRemovalImpact
import cz.semprec.app.domain.MailRepository
import cz.semprec.app.domain.MailSentDraft
import cz.semprec.app.domain.MailSummary
import cz.semprec.app.domain.MailSyncStatus
import cz.semprec.app.domain.MailThreadDetail
import cz.semprec.app.domain.MailThreadPage
import cz.semprec.app.domain.MailThreadQuery
import cz.semprec.app.domain.MailThreadSummary
import cz.semprec.app.domain.MailboxRepository
import cz.semprec.app.domain.OAuthOutcome
import cz.semprec.app.domain.OAuthProvider
import cz.semprec.app.domain.OAuthSignIn
import cz.semprec.app.domain.RepositoryResult
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.TestScope

/** The answer of a scripted mail call that has no script of its own. */
internal fun <T> mailContent(value: T): ScriptedStep<T> = { RepositoryResult.Content(value) }

internal fun <T> mailFailure(kind: FailureKind): ScriptedStep<T> = { RepositoryResult.Failure(kind) }

/** A scripted call: [script] answers, [calls] records what it was asked with. */
internal class MailCall<A, T>(vararg steps: ScriptedStep<T>) {
    private val script = CallScript(steps.toList())
    val asked = mutableListOf<A>()
    val count get() = script.calls
    val cancellations get() = script.cancellations

    suspend fun answer(argument: A): RepositoryResult<T> {
        asked += argument
        return script.next()
    }
}

internal class ScriptedMailRepository(
    val threads: MailCall<MailThreadQuery, MailThreadPage> = MailCall(mailContent(mailPage())),
    val facets: MailCall<Pair<String?, String?>, MailFacets> = MailCall(mailContent(mailFacets())),
    val summary: MailCall<Unit, MailSummary> = MailCall(mailContent(mailSummary())),
    val thread: MailCall<String, MailThreadDetail> = MailCall(mailContent(mailDetail())),
    val read: MailCall<Pair<String, Boolean>, Boolean> = MailCall({ RepositoryResult.Content(false) }),
    val flag: MailCall<Pair<String, Boolean>, Boolean> = MailCall({ RepositoryResult.Content(true) }),
    val moves: MailCall<String, Unit> = MailCall(mailContent(Unit)),
    val tasks: MailCall<String, MailNamedRef> = MailCall(mailContent(MailNamedRef("t9", "Zavolat"))),
) : MailRepository {
    val moved = mutableListOf<String>()

    override suspend fun threads(query: MailThreadQuery) = threads.answer(query)

    override suspend fun facets(areaId: String?, projectId: String?) = facets.answer(areaId to projectId)

    override suspend fun summary() = summary.answer(Unit)

    override suspend fun thread(threadId: String) = thread.answer(threadId)

    override suspend fun setRead(threadId: String, read: Boolean) = this.read.answer(threadId to read)

    override suspend fun setFlagged(threadId: String, flagged: Boolean) = flag.answer(threadId to flagged)

    override suspend fun archive(threadId: String) = move("archive", threadId)

    override suspend fun trash(threadId: String) = move("trash", threadId)

    override suspend fun restore(threadId: String) = move("restore", threadId)

    override suspend fun createTask(threadId: String) = tasks.answer(threadId)

    private suspend fun move(action: String, threadId: String): RepositoryResult<Unit> {
        moved += "$action:$threadId"
        return moves.answer(threadId)
    }
}

internal class ScriptedMailDraftRepository(
    val create: MailCall<Pair<MailDraftFields, String?>, MailDraft> = MailCall(mailContent(mailDraft())),
    val prefilled: MailCall<MailPrefill, MailDraft> = MailCall(mailContent(mailDraft(mode = MailDraftMode.REPLY))),
    val read: MailCall<String, MailDraft> = MailCall(mailContent(mailDraft())),
    val update: MailCall<Triple<String, String, MailDraftFields>, MailDraft> =
        MailCall({ RepositoryResult.Content(mailDraft(version = "v2")) }),
    val discard: MailCall<String, Unit> = MailCall(mailContent(Unit)),
    val send: MailCall<String, MailSentDraft> = MailCall(mailContent(MailSentDraft("d1", "t1", "Gmail"))),
    val contacts: MailCall<Pair<String, List<String>>, List<MailContact>> =
        MailCall(mailContent(listOf(MailContact("Petr Novák", "petr@novak.cz", "Klient")))),
) : MailDraftRepository {
    override suspend fun create(fields: MailDraftFields, threadId: String?) = create.answer(fields to threadId)

    override suspend fun createPrefilled(prefill: MailPrefill) = prefilled.answer(prefill)

    override suspend fun read(draftId: String) = read.answer(draftId)

    override suspend fun update(draftId: String, version: String, fields: MailDraftFields) =
        update.answer(Triple(draftId, version, fields))

    override suspend fun discard(draftId: String) = discard.answer(draftId)

    override suspend fun send(draftId: String) = send.answer(draftId)

    override suspend fun contacts(query: String, exclude: List<String>) = contacts.answer(query to exclude)
}

internal class ScriptedMailboxRepository(
    val list: MailCall<Unit, List<MailAccount>> = MailCall(mailContent(listOf(mailAccount()))),
    val one: MailCall<String, MailAccount> = MailCall(mailContent(mailAccount())),
    val folders: MailCall<String, List<MailFolder>> =
        MailCall(mailContent(listOf(MailFolder("f1", "Inbox", "inbox", 3, 40)))),
    val impact: MailCall<String, MailRemovalImpact> = MailCall(mailContent(MailRemovalImpact(120, 2, 50, 7))),
    val remove: MailCall<String, Unit> = MailCall(mailContent(Unit)),
    val connect: MailCall<MailPasswordAccount, MailConnectOutcome> =
        MailCall(mailContent(MailConnectOutcome.Connected)),
    val passwords: MailCall<Triple<String, String, String?>, MailConnectOutcome> =
        MailCall(mailContent(MailConnectOutcome.Connected)),
    val rename: MailCall<Pair<String, String>, Unit> = MailCall(mailContent(Unit)),
    val limit: MailCall<Pair<String, Int>, Unit> = MailCall(mailContent(Unit)),
) : MailboxRepository {
    override suspend fun mailboxes() = list.answer(Unit)

    override suspend fun mailbox(mailboxId: String) = one.answer(mailboxId)

    override suspend fun folders(mailboxId: String) = folders.answer(mailboxId)

    override suspend fun removalImpact(mailboxId: String) = impact.answer(mailboxId)

    override suspend fun remove(mailboxId: String) = remove.answer(mailboxId)

    override suspend fun connect(account: MailPasswordAccount) = connect.answer(account)

    override suspend fun updatePassword(mailboxId: String, password: String, username: String?) =
        passwords.answer(Triple(mailboxId, password, username))

    override suspend fun rename(mailboxId: String, name: String) = rename.answer(mailboxId to name)

    override suspend fun setConnectionLimit(mailboxId: String, limit: Int) = this.limit.answer(mailboxId to limit)
}

internal class ScriptedInternetAccountRepository(
    val list: MailCall<Unit, List<InternetAccount>> = MailCall(mailContent(listOf(internetAccount()))),
    val one: MailCall<String, InternetAccount> = MailCall(mailContent(internetAccount())),
    val services: MailCall<Triple<String, InternetService, Boolean>, Unit> = MailCall(mailContent(Unit)),
    val syncs: MailCall<String, Unit> = MailCall(mailContent(Unit)),
    val signIns: MailCall<Pair<OAuthProvider, Set<InternetService>>, OAuthSignIn> =
        MailCall(mailContent(OAUTH_SIGN_IN)),
    val reauthorizations: MailCall<Pair<String, Set<InternetService>>, OAuthSignIn> =
        MailCall(mailContent(OAUTH_SIGN_IN)),
    val finishes: MailCall<Pair<OAuthSignIn, String>, OAuthOutcome> =
        MailCall(mailContent(OAuthOutcome.Connected("m1"))),
) : InternetAccountRepository {
    override suspend fun accounts() = list.answer(Unit)

    override suspend fun account(accountId: String) = one.answer(accountId)

    override suspend fun setServiceEnabled(accountId: String, service: InternetService, enabled: Boolean) =
        services.answer(Triple(accountId, service, enabled))

    override suspend fun syncCalendars(accountId: String) = syncs.answer(accountId)

    override suspend fun startSignIn(provider: OAuthProvider, services: Set<InternetService>) =
        signIns.answer(provider to services)

    override suspend fun startReauthorization(accountId: String, services: Set<InternetService>) =
        reauthorizations.answer(accountId to services)

    override suspend fun finishSignIn(signIn: OAuthSignIn, callbackUrl: String) =
        finishes.answer(signIn to callbackUrl)
}

internal val OAUTH_SIGN_IN = OAuthSignIn("https://accounts.google.com/o/oauth2/v2/auth?state=s1", "s1")

internal const val OAUTH_CALLBACK = "semprec://oauth?state=s1&code=c1"

internal fun internetAccount(
    id: String = "m1",
    status: MailSyncStatus = MailSyncStatus.OK,
    mail: Boolean = true,
    calendars: Boolean = false,
    calendarStatus: CalendarSyncStatus = if (calendars) CalendarSyncStatus.PENDING else CalendarSyncStatus.OFF,
    initial: Boolean = false,
    limitApplies: Boolean = true,
    provider: String = "gmail",
) = InternetAccount(
    mailAccount(id, status, initial, limitApplies).copy(provider = provider),
    mail,
    calendars,
    calendarStatus,
)

internal fun mailThread(
    id: String = "t1",
    unread: Boolean = true,
    sender: String = "Petr Novák",
) = MailThreadSummary(
    threadId = id,
    subject = "Re: Nabídka",
    lastMessageAt = "2026-10-20T12:41:00.000000Z",
    senderName = sender,
    senderAddress = "petr@novak.cz",
    senderRelationship = "Klient",
    messageCount = 4,
    preview = "Díky",
    hasAttachment = true,
    unread = unread,
    flagged = false,
    mailboxNames = listOf("Gmail"),
    project = MailNamedRef("pr1", "Web"),
    company = null,
    hasSempDraft = true,
)

internal fun mailPage(vararg threads: MailThreadSummary, next: String? = null) =
    MailThreadPage(threads.toList().ifEmpty { listOf(mailThread()) }, next)

internal fun mailFacets() = MailFacets(
    total = 9,
    areasTotal = 9,
    projectsTotal = 7,
    areas = listOf(
        MailFacetOption("ar1", "Práce", "#5856D6", 4, null),
        MailFacetOption("ar2", "Domácnost", null, 2, null),
    ),
    projects = listOf(
        MailFacetOption("pr1", "Web", "#FF9500", 3, "ar1"),
        MailFacetOption("pr2", "Koupelna", null, 2, "ar2"),
    ),
    selectedAreaName = null,
    selectedProjectName = null,
)

internal fun mailSummary() = MailSummary(5, 2, 1, 2, emptyList())

internal fun mailAccount(
    id: String = "m1",
    status: MailSyncStatus = MailSyncStatus.OK,
    initial: Boolean = false,
    limitApplies: Boolean = true,
) = MailAccount(
    id = id,
    name = "Gmail",
    provider = "gmail",
    primaryAddress = "me@gmail.com",
    syncMode = "imap",
    syncStatus = status,
    initialSyncInProgress = initial,
    lastSuccessfulSyncAt = "2026-10-19T08:12:00.000Z",
    failingSince = "2026-10-19T09:12:00.000Z",
    connectionLimit = 3,
    connectionLimitApplies = limitApplies,
    autonomousSendProjectCount = 1,
)

internal fun mailMessage(
    id: String,
    own: Boolean = false,
    purpose: String? = "inbox",
    mailboxId: String? = "m1",
) = MailMessage(
    emailId = id,
    mailboxId = mailboxId,
    folderPurpose = purpose,
    own = own,
    from = MailAddress("Petr Novák", "petr@novak.cz"),
    to = listOf(MailAddress("", "me@x.cz")),
    cc = emptyList(),
    date = "2026-10-20T12:41:00.000000Z",
    bodyText = "Ahoj $id",
    read = false,
    attachments = emptyList(),
)

internal fun mailDetail(
    messages: List<MailMessage> = listOf(mailMessage("e1"), mailMessage("e2", own = true), mailMessage("e3")),
    unread: Boolean = false,
) = MailThreadDetail(
    threadId = "t1",
    subject = "Re: Nabídka",
    messageCount = messages.size,
    unread = unread,
    flagged = false,
    mailboxNames = listOf("Gmail"),
    senderName = "Petr Novák",
    senderAddress = "petr@novak.cz",
    senderRelationship = "Klient",
    project = MailNamedRef("pr1", "Web"),
    company = null,
    projectLink = null,
    companyLink = null,
    messages = messages,
    tasks = emptyList(),
)

internal fun mailDraft(
    mode: MailDraftMode = MailDraftMode.NEW,
    agent: Boolean = true,
    version: String = "v1",
    body: String = "Dobrý den",
) = MailDraft(
    id = "d1",
    mailboxId = "m1",
    from = "me@gmail.com",
    to = listOf(MailAddress("Petr", "petr@novak.cz")),
    cc = emptyList(),
    bcc = listOf(MailAddress("", "hidden@x.cz")),
    subject = "Re: Nabídka",
    body = body,
    threadId = "t1",
    mode = mode,
    sourceEmailId = "e3",
    createdByAgent = agent,
    version = version,
)

/** Collects the effects of [vm] into a list for the rest of the test; call `runCurrent()` to let them arrive. */
internal fun <E : Any> TestScope.collectEffects(vm: ScreenViewModel<*, *, E>): MutableList<E> {
    val received = mutableListOf<E>()
    backgroundScope.launch { vm.effects.collect { received += it } }
    return received
}
