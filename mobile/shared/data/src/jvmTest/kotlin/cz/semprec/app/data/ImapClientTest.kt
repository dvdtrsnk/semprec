package cz.semprec.app.data

import kotlinx.coroutines.runBlocking
import javax.net.ssl.SNIHostName
import javax.net.ssl.SSLContext
import javax.net.ssl.SSLSocket
import kotlin.io.encoding.Base64
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertContentEquals
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertIs
import kotlin.test.assertTrue

private const val USER = "me@example.com"

/** Answers the commands of a sign-in and of `LOGOUT`; `false` for any other command. */
private fun ImapReply.signIn(command: ImapCommand, capabilities: String = "IMAP4rev1"): Boolean {
    when {
        command.text == "CAPABILITY" -> line("* CAPABILITY $capabilities")
        command.text.startsWith("LOGIN ") || command.text.startsWith("AUTHENTICATE ") -> Unit
        command.text == "LOGOUT" -> line("* BYE logging out")
        else -> return false
    }
    ok(command)
    return true
}

class ImapClientTest {
    private val servers = mutableListOf<FakeImapServer>()

    @AfterTest fun closeServers() = servers.forEach { it.close() }

    private fun server(
        greeting: String? = "* OK fake IMAP ready",
        chunk: Int = Int.MAX_VALUE,
        handler: ImapReply.(ImapCommand) -> Unit = { signIn(it) },
    ) = FakeImapServer(greeting, chunk, handler).also { servers += it }

    private suspend fun FakeImapServer.client(password: String = "secret", timeouts: ImapTimeouts = ImapTimeouts()) =
        ImapClient.signIn(transport, "imap.example.com", USER, password, timeouts)

    private inline fun failureOf(block: () -> Unit): ImapFailure = assertFailsWith<ImapException> { block() }.failure

    @Test
    fun aFetchKeepsEachResponseByteForByteAndOnlyTheFullOnesAskedFor() = runBlocking {
        // A literal that looks like protocol: a UID, a closing parenthesis, a literal announcement, CRLF, 8-bit bytes.
        val tricky = "UID 999 ) {12}\r\n\"\\ é ".encodeToByteArray() + byteArrayOf(0xFF.toByte(), 0x80.toByte())
        val first = fetchResponse(1, 11, text = tricky)
        val second = fetchResponse(2, 12, header = "References: <x@y>\r\nList-Id: (y) \"z\" {3}\r\n\r\n")
        // A literal that ends in CR, and one that ends in what reads as a literal announcement.
        val third = fetchResponse(4, 14, text = "ends in\r".encodeToByteArray())
        val fourth = fetchResponse(5, 15, text = "ends in {5}".encodeToByteArray())
        val server = server(chunk = 7) { command ->
            if (!signIn(command) && command.text.startsWith("UID FETCH")) {
                line("* 4 EXISTS")
                // A flag change the server reports on its own, and a message nobody asked for.
                line("* 1 FETCH (UID 11 FLAGS (\\Seen \\Flagged))")
                bytes(first)
                bytes(second)
                bytes(fetchResponse(3, 13))
                bytes(third)
                bytes(fourth)
                ok(command)
            }
        }
        val client = server.client()

        val fetched = client.uidFetch(listOf(11, 12, 14, 15))

        assertEquals(setOf(11L, 12L, 14L, 15L), fetched.keys)
        assertContentEquals(first, fetched[11])
        assertContentEquals(second, fetched[12])
        assertContentEquals(third, fetched[14])
        assertContentEquals(fourth, fetched[15])
        assertEquals("UID FETCH 11,12,14,15 $MAIL_HISTORY_FETCH_ITEMS", server.commands.last().text)
        client.logout()
    }

    @Test
    fun theLoginQuotesAPrintablePasswordAndSendsAnyOtherAsALiteral() = runBlocking {
        val accented = "heslo žluť\r\n"
        val cases = listOf(
            "plain" to "LOGIN \"$USER\" \"plain\"",
            "pa\"ss\\word" to "LOGIN \"$USER\" \"pa\\\"ss\\\\word\"",
            accented to "LOGIN \"$USER\" {${accented.encodeToByteArray().size}}\r\n$accented",
        )
        for ((password, expected) in cases) {
            val server = server()
            server.client(password).logout()
            assertEquals(listOf("CAPABILITY", expected, "LOGOUT"), server.commands.map { it.text }, password)
        }
    }

    @Test
    fun aServerOfferingPlainAuthenticationIsSignedInWithIt() = runBlocking {
        val plain = Base64.Default.encode("\u0000$USER\u0000secret".encodeToByteArray())
        val inline = server { signIn(it, "IMAP4rev1 SASL-IR AUTH=PLAIN AUTH=XOAUTH2") }
        inline.client().logout()
        assertEquals("AUTHENTICATE PLAIN $plain", inline.commands[1].text)

        val answers = mutableListOf<String>()
        val challenged = server { command ->
            if (command.text == "AUTHENTICATE PLAIN") {
                line("+ ")
                answers += readClientLine()
                ok(command)
            } else {
                signIn(command, "IMAP4rev1 AUTH=PLAIN")
            }
        }
        challenged.client().logout()
        assertEquals(listOf(plain), answers)
        assertTrue(challenged.commands.none { it.text.startsWith("LOGIN") })
    }

    @Test
    fun aPreauthenticatedGreetingSignsInWithoutACommand() = runBlocking {
        val server = server(greeting = "* PREAUTH welcome back")
        server.client().logout()
        assertEquals(listOf("LOGOUT"), server.commands.map { it.text })
    }

    @Test
    fun aRefusedSignInIsRejectedAndClosesTheConnection() = runBlocking {
        val refusals = listOf<ImapReply.(ImapCommand) -> Unit>(
            { if (it.text.startsWith("LOGIN")) line("${it.tag} NO [AUTHENTICATIONFAILED] nope") else signIn(it) },
            { command ->
                if (command.text.startsWith("AUTHENTICATE")) {
                    line("${command.tag} NO nope")
                } else {
                    signIn(command, "IMAP4rev1 SASL-IR AUTH=PLAIN")
                }
            },
            { signIn(it, "IMAP4rev1 LOGINDISABLED") },
        )
        for (refusal in refusals) {
            val server = server(handler = refusal)
            assertEquals(ImapFailure.AUTH_REJECTED, failureOf { server.client() })
            assertTrue(server.awaitClientClosedAll())
        }
    }

    @Test
    fun aGreetingThatIsNoWelcomeEndsTheConnection() = runBlocking {
        val cases = listOf("* BYE too many connections" to ImapFailure.UNREACHABLE, "hello" to ImapFailure.PROTOCOL)
        for ((greeting, failure) in cases) {
            val server = server(greeting = greeting)
            assertEquals(failure, failureOf { server.client() }, greeting)
            assertTrue(server.awaitClientClosedAll())
        }
    }

    @Test
    fun examineEncodesThePathAndAnswersTheUidValidity() = runBlocking {
        val server = server { command ->
            if (!signIn(command) && command.text.startsWith("EXAMINE")) {
                line("* 3 EXISTS")
                line("* OK [UIDVALIDITY 4242] UIDs valid")
                line("* OK [UIDNEXT 9] predicted")
                line("${command.tag} OK [READ-ONLY] done")
            }
        }
        val client = server.client()

        assertEquals(4242L, client.examine("Odeslaná & pošta"))
        assertEquals("EXAMINE \"Odeslan&AOE- &- po&AWE-ta\"", server.commands.last().text)
        client.logout()
    }

    @Test
    fun aRefusedCommandLeavesTheConnectionUsable() = runBlocking {
        val server = server { command ->
            when {
                signIn(command) -> Unit
                command.text.startsWith("EXAMINE") -> line("${command.tag} NO [NONEXISTENT] no such folder")
                command.text.startsWith("UID SEARCH") -> {
                    line("* SEARCH 3 5 9")
                    ok(command)
                }
            }
        }
        val client = server.client()

        assertEquals(ImapFailure.REFUSED, failureOf { client.examine("Gone") })
        assertEquals(listOf(3L, 5L, 9L), client.uidSearch(1, 10))
        assertEquals("UID SEARCH UID 1:10", server.commands.last().text)
        client.logout()
    }

    @Test
    fun answersThatBreakTheProtocolFailAndCloseTheConnection() = runBlocking {
        val answers = listOf<ImapReply.(ImapCommand) -> Unit>(
            { line("${it.tag} BAD what") },
            { line("${it.tag} MAYBE later") },
            {
                line("* SEARCH 3 x")
                ok(it)
            },
            // A literal larger than the client keeps of one response.
            { line("* 1 FETCH (UID 1 BODY[TEXT] {2000000}") },
        )
        for (answer in answers) {
            val server = server { if (!signIn(it)) answer(it) }
            val client = server.client()
            assertEquals(ImapFailure.PROTOCOL, failureOf { client.uidSearch(1, 10) })
            assertTrue(server.awaitClientClosedAll())
        }
    }

    @Test
    fun aSilentServerTimesOutAndTheConnectionIsClosed() = runBlocking {
        val quick = ImapTimeouts(readMillis = 200, commandMillis = 400)
        val mute = server(greeting = null)
        assertEquals(ImapFailure.TIMEOUT, failureOf { mute.client(timeouts = quick) })
        assertTrue(mute.awaitClientClosedAll())

        val stalling = server { if (!signIn(it)) line("* 1 EXISTS") }
        val client = stalling.client(timeouts = ImapTimeouts(readMillis = 5_000, commandMillis = 400))
        assertEquals(ImapFailure.TIMEOUT, failureOf { client.uidSearch(1, 10) })
        assertTrue(stalling.awaitClientClosedAll())
    }

    @Test
    fun theTlsSocketChecksTheCertificateAgainstTheHostAndOffersOnlyModernTls() {
        val socket = assertIs<SSLSocket>(SSLContext.getDefault().socketFactory.createSocket())
        val parameters = verifyingHost(socket, "imap.example.com")
        assertEquals("HTTPS", parameters.endpointIdentificationAlgorithm)
        assertEquals(listOf(SNIHostName("imap.example.com")), parameters.serverNames)
        assertTrue(parameters.protocols.isNotEmpty())
        assertTrue(parameters.protocols.all { it == "TLSv1.2" || it == "TLSv1.3" })
        socket.close()
    }
}
