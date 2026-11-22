import CoreKit
import MailFeature

/// Routes of the Mail feature, on the stack of the tab it was created for. The editor of a message is a sheet over that
/// stack, and so is the Podrobnosti sheet of a task made from a thread. The accounts live in the settings: the profile
/// sheet opens over that stack on the internet accounts, and on the account when one is asked for. The Files item of a
/// saved attachment opens in its item sheet over the stack.
@MainActor
final class AppMailRouter {

    // MARK: - Dependencies
    private let context: NavigationContext
    private let tab: AppTab

    // MARK: - Init
    init(context: NavigationContext, tab: AppTab) {
        self.context = context
        self.tab = tab
    }
}

// MARK: - Protocol conformance
extension AppMailRouter: MailRouting {

    func showList(_ start: MailListStart, title: String?) {
        context.showMail(start, title: title, in: tab)
    }

    func showThread(threadId: String) {
        context.push(.mailThread(threadId: threadId, tab: tab), in: tab)
    }

    func showFolders() {
        context.push(.mailFolders(tab: tab), in: tab)
    }

    func showCompose(_ start: MailComposeStart) {
        context.presentSheet(.mailCompose(start), from: tab)
    }

    func showAccounts() {
        context.presentSheet(.profile(opening: [.page(.internetAccounts)]), from: tab)
    }

    func showAccount(mailboxId: String) {
        context.presentSheet(
            .profile(opening: [.page(.internetAccounts), .internetAccount(accountId: mailboxId)]),
            from: tab
        )
    }

    func showTask(taskId: String) {
        context.showDetails(kind: .task, id: taskId, from: tab)
    }

    func showFile(fileItemId: String) {
        context.showItem(itemId: fileItemId, databaseKey: "files", from: tab)
    }
}

// MARK: - Composition
extension AppComposition {

    /// The router of the Mail screens that sit on the stack of `tab`.
    func mailRouter(in tab: AppTab) -> AppMailRouter {
        AppMailRouter(context: navigation, tab: tab)
    }
}
