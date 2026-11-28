package cz.alldots.app.sdk

import cz.alldots.app.core.FailureKind
import cz.alldots.app.core.SessionStorage
import cz.alldots.app.data.ApiClient
import cz.alldots.app.data.AuthenticatedApi
import cz.alldots.app.data.HttpInboxCaptureRepository
import cz.alldots.app.data.OfflineLayer
import cz.alldots.app.domain.CalendarDay
import cz.alldots.app.domain.InboxCapture
import cz.alldots.app.domain.InboxCaptureFile
import cz.alldots.app.domain.InboxCaptureSource
import cz.alldots.app.domain.RepositoryResult
import cz.alldots.app.presentation.Failed
import cz.alldots.app.presentation.InboxCaptureAttachmentSource
import cz.alldots.app.presentation.InboxCaptureTypeState
import kotlinx.coroutines.CancellationException
import kotlin.io.encoding.Base64
import kotlin.io.encoding.ExperimentalEncodingApi

/** What [InboxCaptureSDK.types] answers: the Inbox item types, or why they could not be read. */
sealed interface InboxCaptureTypesAnswer {
    /** The active types, in the order the server lists them. */
    data class Loaded(val types: List<InboxCaptureTypeState>) : InboxCaptureTypesAnswer

    data class Refused(val failure: Failed) : InboxCaptureTypesAnswer
}

/** What [InboxCaptureSDK.capture] answers: the capture is kept on the device, or why it is not. */
sealed interface InboxCaptureAnswer {
    data object Kept : InboxCaptureAnswer

    data class Refused(val failure: Failed) : InboxCaptureAnswer
}

/**
 * What [InboxCaptureSDK.capturesWait] answers: a capture of the person signed in waits, none does (also when nobody is
 * signed in or no window has kept the person of the session, since then none could be sent), or the count failed and
 * it is not known.
 */
enum class InboxCapturesWaiting { WAITING, NOTHING, UNKNOWN }

/** A file attached to a capture: its name, its media type, its bytes as Base64 text and where it came from. */
data class InboxCaptureFileInput(
    val filename: String,
    val mimeType: String,
    val base64: String,
    val source: InboxCaptureAttachmentSource,
)

/**
 * Inbox captures without a window, for the app's system entry points (an App Intent of the Action button), as
 * docs/adr/2026-11-27-apple-system-entry-points-run-in-the-app-over-a-headless-sdk.md decides. Its calls go out with
 * the session in [sessionStorage], the store the windows sign in to, over the process's [OfflineLayer] of
 * [dataDirectory], the directory the windows keep their data in: the types are answered from what the device keeps
 * when the server cannot answer, and a capture waits in the device's capture outbox
 * (docs/adr/2026-11-27-inbox-captures-wait-in-a-device-outbox-that-outlives-the-session.md). Creating it attaches
 * its sender to that layer only when no window has attached one, so the outbox's rounds go through a window's sender
 * whenever one exists, and a window created later replaces it. It reads nothing ahead, opens no sync socket and holds
 * no ViewModel; a `401` of its own calls does not end the session, which the next window's own call ends. Every call answers a value:
 * an unexpected exception is a failure without a kind, and cancellation is rethrown.
 */
class InboxCaptureSDK(sessionStorage: SessionStorage, dataDirectory: String) {
    private val storage = sessionStorage
    private val offline = OfflineLayer.shared(dataDirectory)
    private val repository = HttpInboxCaptureRepository(
        AuthenticatedApi(
            ApiClient(),
            sessionStorage,
            offline = offline,
            takesOverSender = false,
            onSessionRejected = {},
        ),
    )

    /** Whether a session is stored; a session the server no longer knows still counts until a window ends it. */
    fun signedIn(): Boolean = storage.load() != null

    /** The active Inbox item types, from the server or, when it cannot answer, from the answer the device keeps. */
    suspend fun types(): InboxCaptureTypesAnswer = when (val read = guarded { repository.types() }) {
        is RepositoryResult.Content ->
            InboxCaptureTypesAnswer.Loaded(read.value.map { InboxCaptureTypeState(it.id, it.label, it.emoji) })
        is RepositoryResult.Failure -> InboxCaptureTypesAnswer.Refused(Failed(read.kind))
        null -> InboxCaptureTypesAnswer.Refused(Failed(null))
    }

    /**
     * Adds a capture of [text] (trimmed) on [day] (`YYYY-MM-DD`) at [time] (`HH:mm`) with the type [typeId], `null`
     * for none, and [file] when it has one, to the outbox; it is sent in the background from then on. Refused with
     * `INVALID_DATA` and nothing kept when the text is blank without a file, the day is no calendar day or the file's
     * Base64 does not decode; with `UNAUTHORIZED` when nobody is signed in or no window has kept the person of the
     * session; with `UNAVAILABLE` when the device could not write it.
     */
    suspend fun capture(
        text: String,
        day: String,
        time: String,
        typeId: String?,
        file: InboxCaptureFileInput?,
    ): InboxCaptureAnswer {
        val calendarDay = CalendarDay.parse(day)
        val attached = file?.let { input -> decode(input.base64)?.let(input::domain) }
        val unreadableFile = file != null && attached == null
        val empty = text.isBlank() && file == null
        if (calendarDay == null || unreadableFile || empty) {
            return InboxCaptureAnswer.Refused(Failed(FailureKind.INVALID_DATA))
        }
        val capture = InboxCapture(text.trim(), calendarDay, time, typeId, attached)
        return when (val kept = guarded { repository.capture(capture) }) {
            is RepositoryResult.Content -> InboxCaptureAnswer.Kept
            is RepositoryResult.Failure -> InboxCaptureAnswer.Refused(Failed(kept.kind))
            null -> InboxCaptureAnswer.Refused(Failed(null))
        }
    }

    /**
     * Sends the captures that wait now, or joins the round under way, and answers whether no capture of the person
     * signed in is left; `false` also when nobody is signed in or the round failed unexpectedly. Cancelling the call
     * cancels the round when no other trigger waits for it (a capture just added, a window, a retry after a backoff
     * each wait for the round they started), and loses nothing: a capture is deleted only after the server created
     * its item.
     */
    suspend fun send(): Boolean = try {
        offline.sendCaptures()
    } catch (cancelled: CancellationException) {
        throw cancelled
    } catch (_: Exception) {
        false
    }

    /**
     * Whether a capture of the person signed in waits for the server, counted on the device now:
     * [InboxCapturesWaiting.NOTHING] when nobody is signed in or no window has kept the person of the session, since
     * then none could be sent, and [InboxCapturesWaiting.UNKNOWN] when the count failed unexpectedly, so a failure
     * never reads as nothing waiting.
     */
    suspend fun capturesWait(): InboxCapturesWaiting = waitingAnswer { offline.capturesWait() }
}

/** [InboxCaptureSDK.capturesWait] for [count]: an unexpected exception is not known, cancellation is rethrown. */
internal suspend fun waitingAnswer(count: suspend () -> Boolean): InboxCapturesWaiting = try {
    if (count()) InboxCapturesWaiting.WAITING else InboxCapturesWaiting.NOTHING
} catch (cancelled: CancellationException) {
    throw cancelled
} catch (_: Exception) {
    InboxCapturesWaiting.UNKNOWN
}

private suspend fun <T> guarded(call: suspend () -> RepositoryResult<T>): RepositoryResult<T>? = try {
    call()
} catch (cancelled: CancellationException) {
    throw cancelled
} catch (_: Exception) {
    null
}

@OptIn(ExperimentalEncodingApi::class)
private fun decode(base64: String): ByteArray? = try {
    Base64.decode(base64)
} catch (_: IllegalArgumentException) {
    null
}

private fun InboxCaptureFileInput.domain(bytes: ByteArray): InboxCaptureFile =
    InboxCaptureFile(filename, mimeType, bytes, source.domain())

private fun InboxCaptureAttachmentSource.domain(): InboxCaptureSource = when (this) {
    InboxCaptureAttachmentSource.CAMERA -> InboxCaptureSource.CAMERA
    InboxCaptureAttachmentSource.PHOTO_LIBRARY -> InboxCaptureSource.PHOTO_LIBRARY
    InboxCaptureAttachmentSource.FILES -> InboxCaptureSource.FILES
}
