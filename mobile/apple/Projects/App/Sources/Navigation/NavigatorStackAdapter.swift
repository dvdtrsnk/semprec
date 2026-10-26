import NavigatorUI

/// A NavigatorUI stack as a `StackNavigating`. NavigatorUI tells how many entries the stack's path holds, not which,
/// so the adapter remembers what it pushed. The system removes entries only from the path's end (Back, a back swipe,
/// a pop), so while the adapter is the only code that appends to the path, as it is in the app, the path holds the
/// first `navigator.count` destinations the adapter remembers. An entry other code appended leaves the top unknown
/// until it is popped.
@MainActor
final class NavigatorStackAdapter {

    // MARK: - Dependencies
    let navigator: Navigator

    // MARK: - Properties
    /// The destinations the adapter pushed, bottom first; nil marks an entry that was on the path when the adapter
    /// pushed, but that the adapter did not push. After a pop it holds more entries than the path.
    private var pushed: [AppDestination?] = []

    // MARK: - Init
    init(_ navigator: Navigator) {
        self.navigator = navigator
    }
}

// MARK: - Protocol conformance
extension NavigatorStackAdapter: StackNavigating {

    var top: AppDestination? {
        let depth = navigator.count
        guard depth > 0, depth <= pushed.count else { return nil }
        return pushed[depth - 1]
    }

    func push(_ destination: AppDestination) {
        let depth = navigator.count
        pushed = Array(pushed.prefix(depth)) + Array(repeating: nil, count: max(0, depth - pushed.count))
        navigator.push(destination)
        pushed.append(destination)
    }

    func presentSheet(_ destination: AppDestination) {
        navigator.navigate(to: destination, method: .sheet)
    }
}

// MARK: - Registration
extension NavigationContext {

    /// Registers the stack `navigator` manages for `tab`. A stack's root registers its stack each time it appears, and
    /// SwiftUI does not promise that no entry is on top of it then; so the adapter already registered for the same
    /// navigator stays, and with it what the adapter remembers about the stack's entries.
    func register(_ navigator: Navigator, for tab: AppTab) {
        if let registered = stack(for: tab) as? NavigatorStackAdapter, registered.navigator.id == navigator.id {
            return
        }
        register(NavigatorStackAdapter(navigator), for: tab)
    }
}
