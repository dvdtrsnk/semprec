import Combine
import CoreKit
import Foundation

/// A page of the chat's own stack. The chat is presented over the whole app and keeps a stack of its own, apart from
/// the tabs'.
enum SempRoute: Hashable {

    /// A conversation: the latest chat, a new one, a thread of the history, the thread of an Inbox item.
    case thread(
        start: SempThreadStart,
        threadId: String?,
        inboxItemId: String?,
        title: String?,
        meta: String?
    )
    case chats
    case approvals
    case status
    case run(runId: String, messageId: String?)

    /// The main chat, which the bubble opens: the latest chat the person had.
    static let latest = SempRoute.thread(start: .latest, threadId: nil, inboxItemId: nil, title: nil, meta: nil)
    /// A new, empty chat.
    static let new = SempRoute.thread(start: .new, threadId: nil, inboxItemId: nil, title: nil, meta: nil)
}

/// Whether the chat is open, what it opens on and what is pushed on it. A scene has one, and it is what the bubble, the
/// project agent page and the screens of the chat itself ask to show something.
@MainActor
final class SempChatPresenter: ObservableObject {

    // MARK: - Published Properties
    @Published var isPresented = false
    @Published var path: [SempRoute] = []
    @Published private(set) var root = SempRoute.latest

    // MARK: - Methods
    /// Opens the chat on `route`, replacing what an open chat showed.
    func present(_ route: SempRoute = .latest) {
        path = []
        root = route
        isPresented = true
    }

    /// Pushes `route` on the open chat.
    func push(_ route: SempRoute) {
        path.append(route)
    }

    func dismiss() {
        isPresented = false
    }
}
