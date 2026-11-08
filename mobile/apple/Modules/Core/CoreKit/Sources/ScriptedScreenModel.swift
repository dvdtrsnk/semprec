import Foundation

/// Deterministic in-memory `ScreenModel` for previews and native tests.
@MainActor
public final class ScriptedScreenModel<State: Equatable & Sendable, Action: Sendable, Effect: Sendable>: ScreenModel {

    // MARK: - Properties
    public private(set) var state: State
    public private(set) var actions: [Action] = []
    private var stateContinuation: AsyncStream<State>.Continuation?
    private let effectQueue = EffectQueue<Effect>()

    // MARK: - Init
    /// `effects` wait for the first observer.
    public init(state: State, effects: [Effect] = []) {
        self.state = state
        effects.forEach(effectQueue.send)
    }

    // MARK: - ScreenModel
    public func states() -> AsyncStream<State> {
        let (stream, continuation) = AsyncStream.makeStream(of: State.self, bufferingPolicy: .bufferingNewest(1))
        continuation.yield(state)
        stateContinuation = continuation
        return stream
    }

    public func effects() -> AsyncStream<Effect> {
        effectQueue.stream()
    }

    public func send(_ action: Action) {
        actions.append(action)
    }

    // MARK: - Test controls
    /// Publish a new state to the current observer.
    public func publish(_ newState: State) {
        state = newState
        stateContinuation?.yield(newState)
    }

    /// Raise an effect for the current observer, or the next one when nobody observes.
    public func emit(_ effect: Effect) {
        effectQueue.send(effect)
    }
}
