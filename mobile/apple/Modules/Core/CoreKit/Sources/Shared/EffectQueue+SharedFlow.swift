import Foundation

// MARK: - Kotlin effects
extension EffectQueue {

    /// A queue of every effect of one Kotlin ViewModel. One task collects the Kotlin effect flow for the ViewModel's
    /// whole life, until the flow completes, which closing the Kotlin ViewModel does; the queue then finishes.
    ///
    /// Observers take effects from the queue, never from the Kotlin flow. Cancelling a Swift task that iterates a
    /// SKIE flow does not stop the Kotlin collection: the SKIE iterator starts collecting when it is created and
    /// stops only when it is deallocated, and an effect it has taken from the ViewModel's channel by then never
    /// reaches Swift. Nothing cancels the collecting task, so no effect is lost that way.
    @MainActor
    convenience init<Source: AsyncSequence>(
        collecting source: Source,
        _ transform: @escaping @MainActor (Source.Element) -> Effect
    ) where Source.Failure == Never {
        self.init()
        Task { @MainActor [self] in
            for await element in source { send(transform(element)) }
            finish()
        }
    }
}
