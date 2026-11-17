import CoreKit
import SwiftUI

/// The screens of the Inbox feature. A screen calls `makeModel` once, when SwiftUI creates its `@StateObject`, and
/// owns that model for as long as SwiftUI keeps the screen.
@MainActor
public enum InboxScreenFactory {

    // MARK: - Screens
    /// The Inbox: the stack of cards the person approves, edits or discards.
    public static func inbox(
        makeModel: @escaping @MainActor () -> any InboxScreenModel,
        router: any InboxRouting
    ) -> some View {
        InboxScreen(viewModel: InboxViewModel(model: makeModel(), router: router))
    }
}
