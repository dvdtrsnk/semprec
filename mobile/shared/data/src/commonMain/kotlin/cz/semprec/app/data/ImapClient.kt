package cz.semprec.app.data

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.withTimeoutOrNull
import kotlin.io.encoding.Base64

/**
 * The data items of `UID FETCH`, copied from the server's `MAIL_HISTORY_FETCH_ITEMS`
 * (`backend/packages/data/src/mail/mailHistoryUpload.ts`), which validates every uploaded response against them.
 */
internal const val MAIL_HISTORY_FETCH_ITEMS =
    "(UID FLAGS ENVELOPE BODYSTRUCTURE BODY.PEEK[HEADER.FIELDS (REFERENCES DELIVERED-TO X-ORIGINAL-TO ENVELOPE-TO " +
        "LIST-UNSUBSCRIBE LIST-ID PRECEDENCE AUTO-SUBMITTED)] BODY.PEEK[TEXT]<0.2048>)"

/** The longest single response kept; the server takes at most 64 KiB of one, which leaves headroom to skip it. */
private const val MAX_RESPONSE_BYTES = 1024 * 1024

/** All untagged responses of one command together: 200 messages of the largest uploadable size, and some. */
private const val MAX_COMMAND_BYTES = 24 * 1024 * 1024

/** How long the client waits for the server: silence while it reads, and one command from start to tagged answer. */
internal class ImapTimeouts(val readMillis: Long = 60_000L, val commandMillis: Long = 300_000L)

/**
 * A minimal, read-only IMAP4rev1 client over one connection, for the history upload: the greeting, `CAPABILITY`, a
 * sign-in (`AUTHENTICATE PLAIN` when the server offers it, else `LOGIN`), `EXAMINE`, `UID SEARCH UID`, `UID FETCH`
 * of [MAIL_HISTORY_FETCH_ITEMS] and `LOGOUT`. Commands run one at a time. Every failure is an [ImapException] whose
 * kind is all it carries: no server text, no credential. A command the server refuses with `NO` is
 * [ImapFailure.REFUSED] (on a sign-in [ImapFailure.AUTH_REJECTED]) and leaves the connection usable; any other
 * failure closes the connection.
 */
internal class ImapClient private constructor(private val stream: ImapByteStream, private val timeouts: ImapTimeouts) {
    private val reader = ImapResponseReader(stream, MAX_RESPONSE_BYTES, timeouts.readMillis)
    private var tags = 0

    /** Opens the folder at [path] (a server path, encoded here) read-only and answers its UIDVALIDITY. */
    suspend fun examine(path: String): Long = usable {
        requireOk(command(listOf(ImapPart.Text("EXAMINE "), imapString(modifiedUtf7(path)))))
            .firstNotNullOfOrNull { UIDVALIDITY.find(it.decodeToString())?.groupValues?.get(1) }
            ?.toLongOrNull() ?: throw ImapException(ImapFailure.PROTOCOL)
    }

    /** The UIDs in `[low, high]` of the open folder, as `UID SEARCH UID low:high` lists them. */
    suspend fun uidSearch(low: Long, high: Long): List<Long> = usable {
        requireOk(command(listOf(ImapPart.Text("UID SEARCH UID $low:$high"))))
            .filter { imapStartsWith(it, "* SEARCH") }
            .flatMap { line -> imapWords(line, 2) }
            .map { it.toLongOrNull() ?: throw ImapException(ImapFailure.PROTOCOL) }
    }

    /**
     * The untagged FETCH response of each of [uids] the folder still has, its bytes exactly as the server sent them.
     * A response without ENVELOPE (a flag change the server reports on its own) or of a UID not asked for is not one.
     */
    suspend fun uidFetch(uids: List<Long>): Map<Long, ByteArray> = if (uids.isEmpty()) {
        emptyMap()
    } else {
        usable {
            val text = "UID FETCH ${uids.joinToString(",")} $MAIL_HISTORY_FETCH_ITEMS"
            val asked = uids.toSet()
            val responses = LinkedHashMap<Long, ByteArray>()
            for (response in requireOk(command(listOf(ImapPart.Text(text))))) {
                val uid = fetchItems(response)?.takeIf { "ENVELOPE" in it.names }?.uid
                if (uid != null && uid in asked && uid !in responses) responses[uid] = response
            }
            responses
        }
    }

    /** Logs out within a short wait and closes the connection; never fails. */
    suspend fun logout() {
        try {
            withTimeoutOrNull(LOGOUT_TIMEOUT_MILLIS) { command(listOf(ImapPart.Text("LOGOUT"))) }
        } catch (cancelled: CancellationException) {
            stream.close()
            throw cancelled
        } catch (_: ImapException) {
            // The connection is closed below either way; a failed goodbye changes nothing.
        }
        stream.close()
    }

    /** Closes the connection at once, without logging out; for a client its caller can no longer hand on. */
    fun close() = stream.close()

    private suspend fun greetAndSignIn(username: String, password: String) {
        val greeting = reader.next()
        val failure = when {
            imapStartsWith(greeting, "* PREAUTH") -> null
            imapStartsWith(greeting, "* BYE") -> ImapFailure.UNREACHABLE
            !imapStartsWith(greeting, "* OK") -> ImapFailure.PROTOCOL
            else -> signIn(username, password)
        }
        if (failure != null) throw ImapException(failure)
    }

    /**
     * `AUTHENTICATE PLAIN` when the server offers it, with the response inline (SASL-IR) or after its empty
     * challenge, else `LOGIN`; why it failed, `null` when it did not.
     */
    private suspend fun signIn(username: String, password: String): ImapFailure? {
        val capabilities = requireOk(command(listOf(ImapPart.Text("CAPABILITY"))))
            .filter { imapStartsWith(it, "* CAPABILITY") }
            .flatMap { imapWords(it, 2) }
            .map { it.uppercase() }
            .toSet()
        val credentials = "\u0000$username\u0000$password".encodeToByteArray()
        val plain = Base64.Default.encode(credentials)
        credentials.fill(0)
        val signedIn = when {
            "AUTH=PLAIN" in capabilities && "SASL-IR" in capabilities ->
                command(listOf(ImapPart.Text("AUTHENTICATE PLAIN $plain")))
            "AUTH=PLAIN" in capabilities ->
                command(listOf(ImapPart.Text("AUTHENTICATE PLAIN")), challengeAnswer = plain)
            "LOGINDISABLED" in capabilities -> null
            else -> {
                val secret = imapString(password)
                try {
                    command(listOf(ImapPart.Text("LOGIN "), imapString(username), ImapPart.Text(" "), secret))
                } finally {
                    if (secret is ImapPart.Literal) secret.bytes.fill(0)
                }
            }
        }
        return when (signedIn?.status) {
            ImapStatus.OK -> null
            ImapStatus.NO, null -> ImapFailure.AUTH_REJECTED
            ImapStatus.BAD -> ImapFailure.PROTOCOL
        }
    }

    /** Runs [operation]; any failure but a refused command leaves the connection unusable, so it is closed. */
    private suspend fun <T> usable(operation: suspend () -> T): T = try {
        operation()
    } catch (failed: ImapException) {
        if (failed.failure != ImapFailure.REFUSED) stream.close()
        throw failed
    }

    /** A command bounded by [ImapTimeouts.commandMillis]. */
    private suspend fun command(parts: List<ImapPart>, challengeAnswer: String? = null): Completed =
        withTimeoutOrNull(timeouts.commandMillis) { exchange(parts, challengeAnswer) }
            ?: throw ImapException(ImapFailure.TIMEOUT)

    /**
     * Writes the command, sending each literal after the server's `+`, and the [challengeAnswer] after the `+` that
     * follows the command line; collects the untagged responses until the tagged one. A server that answers instead
     * of `+` completes the command there.
     */
    private suspend fun exchange(parts: List<ImapPart>, challengeAnswer: String?): Completed {
        val tag = "h${++tags}"
        val collected = Collected(tag)
        var completed: Completed? = null
        val chunks = chunks(tag, parts, challengeAnswer)
        try {
            for ((index, chunk) in chunks.withIndex()) {
                if (index > 0) completed = collected.untilContinuation()
                if (completed != null) break
                stream.write(chunk)
            }
        } finally {
            // A sign-in's chunks carry the password; none stays in memory once the command is out or ended.
            chunks.forEach { it.fill(0) }
        }
        return completed ?: collected.untilTagged()
    }

    /** The responses of the command [tag], read until a continuation or its tagged answer. */
    private inner class Collected(private val tag: String) {
        private val untagged = mutableListOf<ByteArray>()
        private var bytes = 0L

        /** `null` once the server asked for more with `+`; the completed command when it answered instead. */
        suspend fun untilContinuation(): Completed? {
            var response = reader.next()
            while (imapStartsWith(response, "* ")) {
                keep(response)
                response = reader.next()
            }
            return if (imapStartsWith(response, "+")) null else completed(response)
        }

        suspend fun untilTagged(): Completed {
            var response = reader.next()
            while (imapStartsWith(response, "* ")) {
                keep(response)
                response = reader.next()
            }
            return completed(response)
        }

        private fun keep(response: ByteArray) {
            bytes += response.size
            if (bytes > MAX_COMMAND_BYTES) throw ImapException(ImapFailure.PROTOCOL)
            untagged += response
        }

        private fun completed(response: ByteArray): Completed {
            val words = if (imapStartsWith(response, "$tag ")) imapWords(response, 1) else emptyList()
            val status = when (words.firstOrNull()?.uppercase()) {
                "OK" -> ImapStatus.OK
                "NO" -> ImapStatus.NO
                "BAD" -> ImapStatus.BAD
                else -> throw ImapException(ImapFailure.PROTOCOL)
            }
            return Completed(status, untagged)
        }
    }

    companion object {
        private const val LOGOUT_TIMEOUT_MILLIS = 5_000L
        private val UIDVALIDITY = Regex("^\\* OK \\[UIDVALIDITY ([0-9]+)\\]", RegexOption.IGNORE_CASE)

        /**
         * Connects to [host] through [transport], reads the greeting and signs in as [username]; the caller logs out.
         * A failure closes what was opened.
         */
        suspend fun signIn(
            transport: ImapTransport,
            host: String,
            username: String,
            password: String,
            timeouts: ImapTimeouts = ImapTimeouts(),
        ): ImapClient {
            val stream = transport.connect(host)
            val client = ImapClient(stream, timeouts)
            try {
                withTimeoutOrNull(timeouts.commandMillis) { client.greetAndSignIn(username, password) }
                    ?: throw ImapException(ImapFailure.TIMEOUT)
            } catch (failed: Throwable) {
                stream.close()
                throw failed
            }
            return client
        }
    }
}

/** How a command ended: its tagged [status] and the untagged responses before it. */
private class Completed(val status: ImapStatus, val untagged: List<ByteArray>)

/** The untagged responses of a command the server completed with `OK`. */
private fun requireOk(completed: Completed): List<ByteArray> = when (completed.status) {
    ImapStatus.OK -> completed.untagged
    ImapStatus.NO -> throw ImapException(ImapFailure.REFUSED)
    ImapStatus.BAD -> throw ImapException(ImapFailure.PROTOCOL)
}

/** What a command writes: up to each literal's announcement, from the literal on, and the challenge answer. */
private fun chunks(tag: String, parts: List<ImapPart>, challengeAnswer: String?): List<ByteArray> {
    val chunks = mutableListOf<ByteArray>()
    var line = ByteSink(Int.MAX_VALUE).apply { append("$tag ") }
    for (part in parts) {
        when (part) {
            is ImapPart.Text -> line.append(part.text)
            is ImapPart.Literal -> {
                line.append("{${part.bytes.size}}\r\n")
                chunks += line.takeBytes()
                line = ByteSink(Int.MAX_VALUE).apply { append(part.bytes) }
            }
        }
    }
    line.append("\r\n")
    chunks += line.takeBytes()
    if (challengeAnswer != null) chunks += "$challengeAnswer\r\n".encodeToByteArray()
    return chunks
}
