import CoreKit
import DesignSystem
import SwiftUI

/// The screens of the Semp feature. A screen calls `makeModel` once, when SwiftUI creates its `@StateObject`, and owns
/// that model for as long as SwiftUI keeps the screen. The app presents the chat over the tabs and owns its stack, so
/// the screens go where `router` says.
@MainActor
public enum SempScreenFactory {

    // MARK: - Chat
    /// A conversation: the latest chat, a new one, a thread of the history, an Inbox item's thread or a task's thread,
    /// as the model `makeSempThread` made says.
    public static func thread(
        makeModel: @escaping @MainActor () -> any SempThreadScreenModel,
        router: any SempRouting
    ) -> some View {
        SempThreadScreen(viewModel: SempThreadViewModel(model: makeModel(), router: router))
    }

    /// The history of chats and automatic tasks.
    public static func chats(
        makeModel: @escaping @MainActor () -> any SempChatsScreenModel,
        router: any SempRouting
    ) -> some View {
        SempChatsScreen(viewModel: SempChatsViewModel(model: makeModel(), router: router))
    }

    /// The health of Semp and the services it depends on.
    public static func status(
        makeModel: @escaping @MainActor () -> any SempStatusScreenModel,
        router: any SempRouting
    ) -> some View {
        SempStatusScreen(viewModel: SempStatusViewModel(model: makeModel(), router: router))
    }

    /// One run of the agent.
    public static func run(
        makeModel: @escaping @MainActor () -> any SempRunScreenModel,
        router: any SempRouting
    ) -> some View {
        SempRunScreen(viewModel: SempRunViewModel(model: makeModel(), router: router))
    }

    /// The approval requests of Semp.
    public static func approvals(
        makeModel: @escaping @MainActor () -> any SempApprovalsScreenModel,
        router: any SempRouting
    ) -> some View {
        SempApprovalsScreen(viewModel: SempApprovalsViewModel(model: makeModel(), router: router))
    }

    // MARK: - Project
    /// The agent of one project.
    public static func projectAgent(
        makeModel: @escaping @MainActor () -> any SempProjectAgentScreenModel,
        router: any SempRouting
    ) -> some View {
        SempProjectAgentScreen(viewModel: SempProjectAgentViewModel(model: makeModel(), router: router))
    }

    // MARK: - Bubble
    /// The floating bubble, over the whole area it is placed in. `registry` holds the objects of the presentation it
    /// floats over, and `open` shows the chat.
    public static func bubble(
        makeModel: @escaping @MainActor () -> any SempBubbleScreenModel,
        router: any SempRouting,
        registry: DropTargetRegistry,
        open: @escaping () -> Void
    ) -> some View {
        SempBubbleScreen(
            viewModel: SempBubbleViewModel(model: makeModel(), router: router),
            registry: registry,
            open: open
        )
    }
}
