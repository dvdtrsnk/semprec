import CoreKit

/// Where the Semp screens lead. The app owns the chat's stack and presents the chat over the tabs, so the screens only
/// say where they want to go.
@MainActor
public protocol SempRouting: AnyObject {

    /// The history of chats.
    func showHistory()
    /// A new, empty chat.
    func showNewChat()
    /// One thread of the history, or of a task; `title` is how the screen that opened it named it.
    func showThread(threadId: String, type: SempThreadType, title: String?)
    /// The chat a problem of the status points to.
    func showChat(threadId: String, messageId: String)
    func showRun(runId: String, messageId: String?)
    func showApprovals()
    func showStatus()
    /// An item a reply changed; the chat closes behind it.
    func showItem(itemId: String, databaseKey: String?)
    /// The agent page of a project.
    func showProject(projectId: String)
    /// The account of a mailbox that needs attention.
    func showMailbox(mailboxId: String)
    /// The chat with the thread of an Inbox item the person dropped on the bubble.
    func showItemThread(inboxItemId: String, title: String, meta: String?)
}

/// A router that goes nowhere, for previews.
@MainActor
final class PreviewSempRouter: SempRouting {

    func showHistory() {}
    func showNewChat() {}
    func showThread(threadId: String, type: SempThreadType, title: String?) {}
    func showChat(threadId: String, messageId: String) {}
    func showRun(runId: String, messageId: String?) {}
    func showApprovals() {}
    func showStatus() {}
    func showItem(itemId: String, databaseKey: String?) {}
    func showProject(projectId: String) {}
    func showMailbox(mailboxId: String) {}
    func showItemThread(inboxItemId: String, title: String, meta: String?) {}
}
