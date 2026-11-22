import CoreKit
import SwiftUI

/// The screens of the Mail feature. A screen calls `makeModel` once, when SwiftUI creates its `@StateObject`, and
/// owns that model for as long as SwiftUI keeps the screen.
@MainActor
public enum MailScreenFactory {

    // MARK: - Screens
    /// The thread list. Every start of it (all mail, an area, a project, a folder, a mailbox) is the same screen over a
    /// model that was made for that start; `title` names the folder when the list is one.
    public static func threads(
        title: String?,
        makeModel: @escaping @MainActor () -> any MailThreadsScreenModel,
        router: any MailRouting
    ) -> some View {
        MailThreadsScreen(viewModel: MailThreadsViewModel(model: makeModel(), router: router), title: title)
    }

    /// One thread with the reply Semp prepared.
    public static func thread(
        makeModel: @escaping @MainActor () -> any MailThreadScreenModel,
        router: any MailRouting
    ) -> some View {
        MailThreadScreen(viewModel: MailThreadViewModel(model: makeModel(), router: router))
    }

    /// The editor of a message; the app presents it as a sheet.
    public static func compose(makeModel: @escaping @MainActor () -> any MailComposeScreenModel) -> some View {
        MailComposeScreen(viewModel: MailComposeViewModel(model: makeModel()))
    }

    /// The mail signals of a project: which people, domains and keywords mark its threads, with the open threads they
    /// match and the assignment of those threads to the project.
    public static func projectSignals(
        makeModel: @escaping @MainActor () -> any ProjectMailSignalsScreenModel
    ) -> some View {
        ProjectMailSignalsScreen(viewModel: ProjectMailSignalsViewModel(model: makeModel()))
    }

    /// The mailboxes with their folders.
    public static func folders(
        makeModel: @escaping @MainActor () -> any MailFoldersScreenModel,
        router: any MailRouting
    ) -> some View {
        MailFoldersScreen(viewModel: MailFoldersViewModel(model: makeModel(), router: router))
    }
}
