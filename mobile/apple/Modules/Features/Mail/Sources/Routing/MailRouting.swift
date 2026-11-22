import CoreKit

/// How the Mail feature asks the app to show something. The app owns every stack and sheet; going back is the
/// screen's own `dismiss`.
@MainActor
public protocol MailRouting: AnyObject {

    /// A thread list: `title` names the folder when the list is one, `nil` is the plain mail list.
    func showList(_ start: MailListStart, title: String?)

    func showThread(threadId: String)

    /// The mailboxes with their folders.
    func showFolders()

    /// The editor of a new message, a reply or a saved draft.
    func showCompose(_ start: MailComposeStart)

    /// The internet accounts, which live in the settings.
    func showAccounts()

    /// One internet account; an account is a mailbox, so `mailboxId` names it.
    func showAccount(mailboxId: String)

    /// The Podrobnosti sheet of a task made from a thread.
    func showTask(taskId: String)

    /// The Files item of a saved attachment, which previews the file and hands it to other apps.
    func showFile(fileItemId: String)
}

/// A router for previews: it goes nowhere.
@MainActor
final class PreviewMailRouter: MailRouting {

    // MARK: - Protocol conformance
    func showList(_ start: MailListStart, title: String?) {}

    func showThread(threadId: String) {}

    func showFolders() {}

    func showCompose(_ start: MailComposeStart) {}

    func showAccounts() {}

    func showAccount(mailboxId: String) {}

    func showTask(taskId: String) {}

    func showFile(fileItemId: String) {}
}
