import Foundation

/// One tab's navigation stack.
@MainActor
protocol StackNavigating: AnyObject {

    /// The destination on top of the stack: nil when the stack shows its root, or when it cannot tell what is on top.
    var top: AppDestination? { get }

    func push(_ destination: AppDestination)
    func presentSheet(_ destination: AppDestination)
}
