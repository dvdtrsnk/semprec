package cz.alldots.app.presentation

import kotlinx.coroutines.CoroutineScope

/**
 * What one part of a screen's logic (a flow) may do to the ViewModel that owns it: launch work in its scope, which
 * is cancelled when the ViewModel is closed, read and replace its state, and emit its effects.
 */
internal class FlowHost<State : Any, Effect : Any>(
    val scope: CoroutineScope,
    private val read: () -> State,
    private val replace: ((State) -> State) -> Unit,
    private val send: (Effect) -> Unit,
) {
    val state: State get() = read()

    fun update(transform: (State) -> State) = replace(transform)

    fun emit(effect: Effect) = send(effect)
}
