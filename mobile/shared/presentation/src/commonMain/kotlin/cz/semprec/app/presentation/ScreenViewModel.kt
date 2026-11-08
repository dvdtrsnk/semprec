package cz.semprec.app.presentation

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.cancel
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.receiveAsFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.isActive

/**
 * Base for shared screen logic. A screen has one immutable [State], user intents as [Action], and
 * one-time native requests (navigation, dialogs) as [Effect].
 *
 * Lifetime: on Android a `ViewModelStore` owns the instance and clears it when its owner is gone; Android
 * never calls [close]. An owner without a store (the Apple CoreKit bridge, through its lease) calls [close]
 * when the screen is gone. Clearing and [close] both cancel [viewModelScope] and close the effect channel:
 * [isClosed] turns `true`, [effects] completes, an effect emitted afterwards is dropped, and [state] keeps
 * its last value.
 */
abstract class ScreenViewModel<State : Any, Action : Any, Effect : Any>(initialState: State) : ViewModel() {
    private val mutableState = MutableStateFlow(initialState)
    private val effectChannel = Channel<Effect>(Channel.UNLIMITED)

    /** Current screen state. Collectors always receive the latest value first. */
    val state: StateFlow<State> = mutableState.asStateFlow()

    /**
     * One-time requests to the native owner, carried by an unlimited channel. Effects are delivered in
     * emission order, each to at most one collector, and never replayed; effects emitted while nobody collects
     * wait for the next collector. A collector that is cancelled after the channel handed it an effect but
     * before it resumed drops that effect (the prompt cancellation of kotlinx.coroutines), so on its own this
     * flow delivers each effect at most once.
     *
     * Collect it once per ViewModel, in a host that cannot be cancelled in that window: Android's
     * `CollectEffects` (`:android:core:ui`) collects on `Dispatchers.Main.immediate`, so an effect emitted on
     * the main thread is processed before any lifecycle event can cancel the collector, and each Apple CoreKit
     * bridge collects once for its whole life into its `EffectQueue`. A second collector would split the
     * effects. Because every effect is emitted on the main thread (see [emit]), each one is delivered exactly
     * once while the ViewModel (Android) or its bridge (Apple) lives.
     *
     * After clearing or [close], the flow hands out the effects emitted before and then completes.
     */
    val effects: Flow<Effect> = effectChannel.receiveAsFlow()

    /** `true` once [close] ran or the owning `ViewModelStore` cleared this instance; never `false` again. */
    val isClosed: Boolean get() = !viewModelScope.isActive

    /** The only input; hosts call it on the main thread. A concrete ViewModel ignores it once [isClosed]. */
    abstract fun onAction(action: Action)

    /**
     * Ends this ViewModel for an owner without a `ViewModelStore`, as clearing does: cancels [viewModelScope]
     * and closes the effect channel. Idempotent; see the class documentation for what stays and what is
     * dropped.
     */
    fun close() {
        viewModelScope.cancel()
        effectChannel.close()
    }

    /**
     * Called when the owning `ViewModelStore` clears this instance, which also cancels [viewModelScope].
     * Closes the effect channel, so clearing ends everything [close] ends.
     */
    override fun onCleared() {
        effectChannel.close()
    }

    protected fun update(transform: (State) -> State) {
        mutableState.update(transform)
    }

    /**
     * Sends a one-time request to the native owner, dropped once this ViewModel is closed. Call it only on the
     * main thread, from [onAction] or from work in [viewModelScope] (which runs on `Dispatchers.Main.immediate`):
     * an effect emitted on another thread keeps only the at-most-once guarantee of [effects].
     */
    protected fun emit(effect: Effect) {
        effectChannel.trySend(effect)
    }
}
