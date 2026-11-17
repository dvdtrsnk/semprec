import CoreKit

// MARK: - Mail
extension NavigationContext {

    /// Pushes a thread list onto the stack of `tab`: all mail, the mail of an area or of a project, a folder or one
    /// mailbox, as `start` says. `title` names the folder when the list is one.
    func showMail(_ start: MailListStart, title: String? = nil, in tab: AppTab) {
        push(.mailList(start, title: title, tab: tab), in: tab)
    }

    /// Pushes the connected e-mail accounts onto the stack of `tab`.
    func showMailAccounts(in tab: AppTab) {
        push(.mailAccounts(tab: tab), in: tab)
    }
}
