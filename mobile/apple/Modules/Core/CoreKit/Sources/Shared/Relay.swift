import Foundation

/// Relays a Kotlin state flow as a native stream for one observer. Cancelling the iterating task cancels Kotlin
/// collection. A state flow always starts with its latest value, so a new observer misses nothing.
@MainActor
func relay<Source: AsyncSequence, Value: Sendable>(
    _ source: Source,
    buffering: AsyncStream<Value>.Continuation.BufferingPolicy,
    _ transform: @escaping @MainActor (Source.Element) -> Value
) -> AsyncStream<Value> where Source.Failure == Never {
    AsyncStream(bufferingPolicy: buffering) { continuation in
        let task = Task { @MainActor in
            for await element in source {
                guard !Task.isCancelled else { break }
                continuation.yield(transform(element))
            }
            continuation.finish()
        }
        continuation.onTermination = { @Sendable _ in task.cancel() }
    }
}
