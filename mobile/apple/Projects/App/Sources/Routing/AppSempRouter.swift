import CoreKit
import SempFeature

/// Routes of the Semp feature. The router of a screen inside the chat pushes onto the chat's stack; the router of a
/// screen in a tab (the agent page of a project) opens the chat on the page it asks for. Pages of the app that the chat
/// reaches (an item a reply changed, a project) open in the tab the person came from, behind the closing chat.
@MainActor
final class AppSempRouter {

    // MARK: - Dependencies
    private let presenter: SempChatPresenter
    private let context: NavigationContext
    private let tab: () -> AppTab
    private let insideChat: Bool

    // MARK: - Init
    init(presenter: SempChatPresenter, context: NavigationContext, tab: @escaping () -> AppTab, insideChat: Bool) {
        self.presenter = presenter
        self.context = context
        self.tab = tab
        self.insideChat = insideChat
    }
}

// MARK: - Protocol conformance
extension AppSempRouter: SempRouting {

    func showHistory() {
        show(.chats)
    }

    func showNewChat() {
        show(.new)
    }

    func showThread(threadId: String, type: SempThreadType, title: String?) {
        show(.thread(start: .existing, threadId: threadId, inboxItemId: nil, title: title, meta: nil))
    }

    func showChat(threadId: String, messageId: String) {
        show(.thread(start: .existing, threadId: threadId, inboxItemId: nil, title: nil, meta: nil))
    }

    func showRun(runId: String, messageId: String?) {
        show(.run(runId: runId, messageId: messageId))
    }

    func showApprovals() {
        show(.approvals)
    }

    func showStatus() {
        show(.status)
    }

    func showItem(itemId: String, databaseKey: String?) {
        afterClosing { [context, tab] in
            switch databaseKey {
            case "tasks": context.showDetails(kind: .task, id: itemId, from: tab())
            case "events": context.showDetails(kind: .event, id: itemId, from: tab())
            default: context.push(.collectionItem(itemId: itemId, databaseKey: databaseKey), in: tab())
            }
        }
    }

    func showProject(projectId: String) {
        afterClosing { [context, tab] in
            context.push(.collectionItem(itemId: projectId, databaseKey: "projects"), in: tab())
        }
    }

    func showItemThread(inboxItemId: String, title: String, meta: String?) {
        presenter.present(.thread(start: .item, threadId: nil, inboxItemId: inboxItemId, title: title, meta: meta))
    }
}

// MARK: - Private
private extension AppSempRouter {

    /// Closes the chat and, once its cover is gone, runs `open`: a screen of a tab cannot be shown under a cover
    /// that is still going away.
    func afterClosing(_ open: @escaping @MainActor () -> Void) {
        presenter.dismiss()
        Task { @MainActor in
            try? await Task.sleep(for: .milliseconds(450))
            open()
        }
    }

    func show(_ route: SempRoute) {
        if insideChat {
            presenter.push(route)
        } else {
            presenter.present(route)
        }
    }
}
