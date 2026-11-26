import Combine
import Foundation

/// The navigation of one scene: the stack of each tab, registered when the tab's stack appears. There is no
/// process-wide navigator, so scenes never navigate each other.
@MainActor
final class NavigationContext {

    // MARK: - Properties
    private var stacks: [AppTab: any StackNavigating] = [:]
    /// The route waiting for each tab's stack to register; it receives the context, so it holds none.
    private var waitingRoutes: [AppTab: @MainActor (NavigationContext) -> Void] = [:]
    /// The tabs a router asked to show; the scene selects each one. A subject rather than a stored closure, so that the
    /// scene's selection, which the scene's state holds, is never held by the context the composition keeps.
    let tabRequests = PassthroughSubject<AppTab, Never>()
    /// Whether something covers the whole window, as the wake guard does: no route opens anything under it, so that a
    /// tapped notification or any other route cannot put a screen above it.
    var isBlocked = false
}

// MARK: - Stack registration
extension NavigationContext {

    /// Makes `stack` the stack of `tab`, replacing a stack registered before, and runs the route that waited for it.
    func register(_ stack: any StackNavigating, for tab: AppTab) {
        stacks[tab] = stack
        waitingRoutes.removeValue(forKey: tab)?(self)
    }

    /// The stack registered for `tab`, or nil before one is.
    func stack(for tab: AppTab) -> (any StackNavigating)? {
        stacks[tab]
    }
}

// MARK: - Routing
extension NavigationContext {

    /// Asks the scene to show `tab`.
    func select(_ tab: AppTab) {
        guard !isBlocked else { return }
        tabRequests.send(tab)
    }

    /// Pushes `destination` onto the stack of `tab`; does nothing before that stack is registered. A destination that
    /// is already on top of that stack, such as the detail of the item a second tap selected again, is not pushed
    /// again; the detail of another item still stacks on top of it.
    func push(_ destination: AppDestination, in tab: AppTab) {
        guard !isBlocked, let stack = stacks[tab], stack.top != destination else { return }
        stack.push(destination)
    }

    /// Presents `destination` as a sheet over the stack of `tab`; does nothing before that stack is registered.
    func presentSheet(_ destination: AppDestination, from tab: AppTab) {
        guard !isBlocked else { return }
        stacks[tab]?.presentSheet(destination)
    }

    /// Shows `tab` and runs `route` on its stack: at once when the stack is registered, otherwise as soon as it
    /// registers, which a tab never shown in this scene does when it is selected. A later route for the same tab
    /// replaces one still waiting.
    func whenShown(_ tab: AppTab, route: @escaping @MainActor (NavigationContext) -> Void) {
        guard !isBlocked else { return }
        select(tab)
        if stacks[tab] != nil {
            route(self)
        } else {
            waitingRoutes[tab] = route
        }
    }

    /// Dismisses the sheets presented over the stack of `tab`.
    func dismissSheets(in tab: AppTab) {
        stacks[tab]?.dismissPresented()
    }

    /// Dismisses the sheets presented over every registered stack: what covers the whole window, as the wake guard
    /// does, must not have a sheet above it.
    func dismissAllPresented() {
        for stack in stacks.values {
            stack.dismissPresented()
        }
    }
}
