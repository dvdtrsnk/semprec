import Foundation

/// The navigation of one scene: the stack of each tab, registered when the tab's stack appears. There is no
/// process-wide navigator, so scenes never navigate each other.
@MainActor
final class NavigationContext {

    // MARK: - Properties
    private var stacks: [AppTab: any StackNavigating] = [:]
}

// MARK: - Stack registration
extension NavigationContext {

    /// Makes `stack` the stack of `tab`, replacing a stack registered before.
    func register(_ stack: any StackNavigating, for tab: AppTab) {
        stacks[tab] = stack
    }

    /// The stack registered for `tab`, or nil before one is.
    func stack(for tab: AppTab) -> (any StackNavigating)? {
        stacks[tab]
    }
}

// MARK: - Routing
extension NavigationContext {

    /// Pushes `destination` onto the stack of `tab`; does nothing before that stack is registered. A destination that
    /// is already on top of that stack, such as the detail of the item a second tap selected again, is not pushed
    /// again; the detail of another item still stacks on top of it.
    func push(_ destination: AppDestination, in tab: AppTab) {
        guard let stack = stacks[tab], stack.top != destination else { return }
        stack.push(destination)
    }

    /// Presents `destination` as a sheet over the stack of `tab`; does nothing before that stack is registered.
    func presentSheet(_ destination: AppDestination, from tab: AppTab) {
        stacks[tab]?.presentSheet(destination)
    }
}
