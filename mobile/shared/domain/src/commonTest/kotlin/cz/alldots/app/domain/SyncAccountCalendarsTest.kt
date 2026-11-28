package cz.alldots.app.domain

import cz.alldots.app.core.FailureKind
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals

/**
 * Answers the scripted accounts and records the syncs it is asked for; nothing else is used. While [gate] is set, a
 * sync waits for it.
 */
private class SyncRecordingAccounts(
    var accounts: RepositoryResult<List<InternetAccount>>,
    val syncAnswers: Map<String, RepositoryResult<Unit>> = emptyMap(),
) : InternetAccountRepository {
    val calls = mutableListOf<String>()
    var gate: CompletableDeferred<Unit>? = null

    override suspend fun accounts(): RepositoryResult<List<InternetAccount>> {
        calls += "accounts"
        return accounts
    }

    override suspend fun syncCalendars(accountId: String): RepositoryResult<Unit> {
        calls += "sync $accountId"
        gate?.await()
        return syncAnswers[accountId] ?: RepositoryResult.Content(Unit)
    }

    override suspend fun account(accountId: String) = error("not used")

    override suspend fun setServiceEnabled(accountId: String, service: InternetService, enabled: Boolean) =
        error("not used")

    override suspend fun startSignIn(provider: OAuthProvider, services: Set<InternetService>) = error("not used")

    override suspend fun startReauthorization(accountId: String, services: Set<InternetService>) =
        error("not used")

    override suspend fun finishSignIn(signIn: OAuthSignIn, callbackUrl: String) = error("not used")
}

private fun account(id: String, calendars: Boolean) = InternetAccount(
    MailAccount(id, id, "gmail", null, "full", MailSyncStatus.OK, false, null, null, 5, true, 0),
    mailEnabled = true,
    calendarsEnabled = calendars,
    calendarStatus = if (calendars) CalendarSyncStatus.OK else CalendarSyncStatus.OFF,
)

private val ONE_ROUND = listOf("accounts", "sync a")

class SyncAccountCalendarsTest {
    @Test fun `asks to sync every account with calendars switched on`() = runTest {
        val accounts = SyncRecordingAccounts(
            RepositoryResult.Content(listOf(account("a", true), account("b", false), account("c", true))),
        )
        SyncAccountCalendars(accounts)()
        assertEquals(listOf("accounts", "sync a", "sync c"), accounts.calls)
    }

    @Test fun `sends every request however close together`() = runTest {
        val accounts = SyncRecordingAccounts(RepositoryResult.Content(listOf(account("a", true))))
        val sync = SyncAccountCalendars(accounts)
        sync()
        sync()
        sync()
        assertEquals(ONE_ROUND + ONE_ROUND + ONE_ROUND, accounts.calls)
    }

    @Test fun `requests made while one is under way wait for it and are served by one more`() = runTest {
        val accounts = SyncRecordingAccounts(RepositoryResult.Content(listOf(account("a", true))))
        val gate = CompletableDeferred<Unit>()
        accounts.gate = gate
        val sync = SyncAccountCalendars(accounts)
        val first = launch { sync() }
        runCurrent()
        val waiting = List(3) { launch { sync() } }
        runCurrent()
        assertEquals(ONE_ROUND, accounts.calls)
        assertEquals(listOf(false, false, false), waiting.map { it.isCompleted })

        accounts.gate = null
        gate.complete(Unit)
        runCurrent()
        assertEquals(ONE_ROUND + ONE_ROUND, accounts.calls)
        assertEquals(listOf(true, true, true, true), (listOf(first) + waiting).map { it.isCompleted })
    }

    @Test fun `a request whose round was cancelled is sent by the next waiting request`() = runTest {
        val accounts = SyncRecordingAccounts(RepositoryResult.Content(listOf(account("a", true))))
        accounts.gate = CompletableDeferred()
        val sync = SyncAccountCalendars(accounts)
        val first = launch { sync() }
        runCurrent()
        val second = launch { sync() }
        runCurrent()
        val third = launch { sync() }
        runCurrent()
        // The second request's round takes the third with it; its caller goes away while it is under way.
        first.cancel()
        runCurrent()
        assertEquals(ONE_ROUND + ONE_ROUND, accounts.calls)
        second.cancel()
        accounts.gate = null
        runCurrent()
        assertEquals(ONE_ROUND + ONE_ROUND + ONE_ROUND, accounts.calls)
        assertEquals(true, third.isCompleted)
    }

    @Test fun `a refused or missing sync of one account does not stop the others or the next request`() = runTest {
        val accounts = SyncRecordingAccounts(
            RepositoryResult.Content(listOf(account("a", true), account("b", true), account("c", true))),
            mapOf(
                "a" to RepositoryResult.Failure(FailureKind.NOT_FOUND),
                "b" to RepositoryResult.Failure(FailureKind.UNAVAILABLE),
            ),
        )
        val sync = SyncAccountCalendars(accounts)
        sync()
        sync()
        val round = listOf("accounts", "sync a", "sync b", "sync c")
        assertEquals(round + round, accounts.calls)
    }

    @Test fun `accounts that could not be read let the next request through`() = runTest {
        val accounts = SyncRecordingAccounts(RepositoryResult.Failure(FailureKind.UNAVAILABLE))
        val sync = SyncAccountCalendars(accounts)
        sync()
        accounts.accounts = RepositoryResult.Content(listOf(account("a", true)))
        sync()
        assertEquals(listOf("accounts", "accounts", "sync a"), accounts.calls)
    }
}
