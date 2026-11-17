import Foundation

/// Native view of one shared screen ViewModel: current state, state updates, one-time effects and intents.
///
/// A production implementation wraps the KMP ViewModel and owns its lifetime. Previews and tests use
/// `ScriptedScreenModel`, so features never need the Kotlin runtime.
@MainActor
public protocol ScreenModel<State, Action, Effect>: AnyObject, Sendable {

    associatedtype State: Equatable & Sendable
    associatedtype Action: Sendable
    associatedtype Effect: Sendable

    /// Latest state; valid synchronously so a screen never renders a placeholder first.
    var state: State { get }

    /// The current state first, then each change. Ends when the iterating task is cancelled.
    func states() -> AsyncStream<State>

    /// The effects for one observing task, each delivered to one observer once and in order. Effects raised while
    /// nobody observes wait for the next stream. A newer stream ends the previous one; an observer whose task is
    /// cancelled takes no further effect, so what it has not taken goes to the next stream.
    func effects() -> AsyncStream<Effect>

    func send(_ action: Action)
}

// MARK: - Observation
extension ScreenModel {

    /// Applies state changes and effects until the surrounding task is cancelled by the screen's owner.
    public func observe(
        onState: @escaping @MainActor @Sendable (State) -> Void,
        onEffect: @escaping @MainActor @Sendable (Effect) -> Void
    ) async {
        let stateTask = Task { @MainActor in
            for await state in states() { onState(state) }
        }
        let effectTask = Task { @MainActor in
            for await effect in effects() { onEffect(effect) }
        }
        await withTaskCancellationHandler {
            await stateTask.value
            await effectTask.value
        } onCancel: {
            stateTask.cancel()
            effectTask.cancel()
        }
    }
}

// MARK: - Observation without effects
extension ScreenModel where Effect == Never {

    /// Applies state changes until the surrounding task is cancelled by the screen's owner.
    public func observe(onState: @escaping @MainActor @Sendable (State) -> Void) async {
        for await state in states() { onState(state) }
    }
}
