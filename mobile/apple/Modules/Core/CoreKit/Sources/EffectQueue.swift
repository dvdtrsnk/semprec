import Synchronization

/// The one-time effects of one screen model, each handed to one observer once, in the order they were sent.
///
/// Only the task iterating the newest `stream()` takes effects, and only while it is not cancelled: an effect leaves
/// the queue when that task asks for its next element. Every effect nobody has taken waits for the next stream,
/// whether it was sent while nobody observed, sent while the observer's task was being cancelled, or left when the
/// observer stopped iterating. A newer stream ends the older one, so two streams never take from the queue at once.
/// An observer whose task is cancelled after it took an effect still receives that effect.
final class EffectQueue<Effect: Sendable>: Sendable {

    // MARK: - Properties
    private let state = Mutex(State())

    // MARK: - Methods
    /// Queues `effect` for the current or the next observer.
    func send(_ effect: Effect) {
        let waiting = state.withLock { state in
            state.pending.append(effect)
            return state.takeWaiting()
        }
        waiting.forEach { $0.resume() }
    }

    /// No effect follows: every stream ends once nothing is left for it to take.
    func finish() {
        let waiting = state.withLock { state in
            state.isFinished = true
            return state.takeWaiting()
        }
        waiting.forEach { $0.resume() }
    }

    /// The effects for a new observer, iterated by one task. It ends the previous stream.
    func stream() -> AsyncStream<Effect> {
        let (observer, waiting) = state.withLock { state in
            state.observer &+= 1
            return (state.observer, state.takeWaiting())
        }
        waiting.forEach { $0.resume() }
        return AsyncStream(unfolding: { [self] in await next(for: observer) })
    }
}

// MARK: - Private
private extension EffectQueue {

    enum Step {

        case effect(Effect)
        case end
        case wait
    }

    struct State {

        var pending: [Effect] = []
        /// Identifies the newest stream; only its observer takes effects.
        var observer = 0
        /// Tasks of the newest stream's observer that wait for a change.
        var waiting: [CheckedContinuation<Void, Never>] = []
        var isFinished = false

        /// What `observer` does now: take the oldest effect, end its stream (its task is cancelled, a newer stream
        /// started, or the queue finished with nothing left) or wait.
        mutating func step(for observer: Int) -> Step {
            guard !Task.isCancelled, observer == self.observer else { return .end }
            if !pending.isEmpty { return .effect(pending.removeFirst()) }
            return isFinished ? .end : .wait
        }

        /// `true` when `step(for:)` would answer `.wait`.
        func mustWait(_ observer: Int) -> Bool {
            !Task.isCancelled && observer == self.observer && pending.isEmpty && !isFinished
        }

        mutating func takeWaiting() -> [CheckedContinuation<Void, Never>] {
            defer { waiting.removeAll() }
            return waiting
        }
    }

    /// The next effect for `observer`; `nil` ends its stream.
    func next(for observer: Int) async -> Effect? {
        while true {
            switch state.withLock({ $0.step(for: observer) }) {
            case .effect(let effect): return effect
            case .end: return nil
            case .wait: await waitForChange(of: observer)
            }
        }
    }

    /// Returns after a send, a finish, a newer stream or the cancellation of the calling task.
    func waitForChange(of observer: Int) async {
        await withTaskCancellationHandler {
            await withCheckedContinuation { continuation in
                // Checked again under the lock, so a change since `step(for:)` answered `.wait` is not missed.
                let waits = state.withLock { state in
                    guard state.mustWait(observer) else { return false }
                    state.waiting.append(continuation)
                    return true
                }
                if !waits {
                    continuation.resume()
                }
            }
        } onCancel: {
            // A cancellation before the continuation is stored makes `mustWait` false, because the task's cancelled
            // flag is set before this handler runs.
            let waiting = state.withLock { state in
                state.observer == observer ? state.takeWaiting() : []
            }
            waiting.forEach { $0.resume() }
        }
    }
}
