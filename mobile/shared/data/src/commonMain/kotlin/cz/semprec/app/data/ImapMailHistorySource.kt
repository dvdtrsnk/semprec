package cz.semprec.app.data

import cz.semprec.app.core.FailureKind
import cz.semprec.app.domain.MailHistoryImap
import cz.semprec.app.domain.MailHistoryImapSession
import cz.semprec.app.domain.MailHistoryLogin
import cz.semprec.app.domain.RepositoryResult
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/**
 * The IMAP server of a password mailbox over [ImapClient], implicit TLS on 993 in production. Parsing runs off the
 * main thread; an IMAP failure becomes its [FailureKind] as [MailHistoryImap] lists them.
 */
class ImapMailHistorySource internal constructor(
    private val transport: ImapTransport,
    private val timeouts: ImapTimeouts,
) : MailHistoryImap {
    constructor() : this(tlsImapTransport(), ImapTimeouts())

    override suspend fun open(login: MailHistoryLogin): RepositoryResult<MailHistoryImapSession> {
        var signedIn: ImapClient? = null
        return try {
            attempt {
                val client = ImapClient.signIn(transport, login.host, login.username, login.password, timeouts)
                signedIn = client
                ImapHistorySession(client)
            }
        } catch (cancelled: CancellationException) {
            // Cancelled once the sign-in had finished: the session never reached the caller, so nobody else closes it.
            signedIn?.close()
            throw cancelled
        }
    }
}

private class ImapHistorySession(private val client: ImapClient) : MailHistoryImapSession {
    override suspend fun examine(path: String) = attempt { client.examine(path) }

    override suspend fun search(low: Long, high: Long) = attempt { client.uidSearch(low, high) }

    override suspend fun fetch(uids: List<Long>) = attempt { client.uidFetch(uids) }

    override suspend fun close() = withContext(Dispatchers.Default) { client.logout() }
}

private suspend fun <T> attempt(call: suspend () -> T): RepositoryResult<T> = try {
    RepositoryResult.Content(withContext(Dispatchers.Default) { call() })
} catch (failed: ImapException) {
    RepositoryResult.Failure(
        when (failed.failure) {
            ImapFailure.AUTH_REJECTED -> FailureKind.UNAUTHORIZED
            ImapFailure.REFUSED -> FailureKind.REJECTED
            ImapFailure.PROTOCOL -> FailureKind.INVALID_DATA
            ImapFailure.TLS_FAILED, ImapFailure.UNREACHABLE, ImapFailure.TIMEOUT -> FailureKind.UNAVAILABLE
        },
    )
}
