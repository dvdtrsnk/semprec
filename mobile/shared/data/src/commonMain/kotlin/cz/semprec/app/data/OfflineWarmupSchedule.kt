package cz.semprec.app.data

import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlin.concurrent.atomics.AtomicBoolean
import kotlin.concurrent.atomics.AtomicReference
import kotlin.concurrent.atomics.ExperimentalAtomicApi
import kotlin.time.Duration
import kotlin.time.Duration.Companion.minutes
import kotlin.time.TimeMark
import kotlin.time.TimeSource

/** How often, at most, the offline set of one account is read ahead of the screens. */
internal val WARMUP_EVERY: Duration = 30.minutes

/**
 * When the offline set is read ahead of the screens (docs/adr/2026-11-23-mobile-keeps-the-answers-of-the-offline-
 * set.md). A warm-up becomes due when a window registers its [OfflineWarmup] ([register]), when an answer ends the
 * offline state and when a sync socket connects ([due]); [runIfDue] runs once the queue replay that follows has
 * finished. It runs the warm-up of the window registered last, at most once every [WARMUP_EVERY] per account for
 * the whole process, never while the process is offline and never without a session, and the warm-up stops once the
 * process turns offline; a due warm-up that cannot run then is dropped, and the next trigger makes one due again.
 */
@OptIn(ExperimentalAtomicApi::class)
internal class OfflineWarmupSchedule(private val state: LayerState, private val timeSource: TimeSource) {
    private val pending = AtomicBoolean(false)
    private val warmup = AtomicReference<OfflineWarmup?>(null)
    private val lock = Mutex()
    private val started = HashMap<String, TimeMark>()

    /** The window's [next] reads ahead from now on; a warm-up is due. */
    fun register(next: OfflineWarmup) {
        warmup.store(next)
        pending.store(true)
    }

    fun due() {
        pending.store(true)
    }

    /** Runs the registered warm-up when one is due and may run now. */
    suspend fun runIfDue() {
        val due = pending.exchange(false)
        val next = warmup.load()?.takeIf { due } ?: return
        val account = next.account() ?: return
        if (!offline() && startsNow(account)) next.run { !offline() }
    }

    private suspend fun offline(): Boolean = state.locked { state.connectivity.offline }

    /** Whether a warm-up of [account] may start now, [WARMUP_EVERY] after the last one; marks it as started. */
    private suspend fun startsNow(account: String): Boolean = lock.withLock {
        val last = started[account]
        val may = last == null || last.elapsedNow() >= WARMUP_EVERY
        if (may) started[account] = timeSource.markNow()
        may
    }
}
