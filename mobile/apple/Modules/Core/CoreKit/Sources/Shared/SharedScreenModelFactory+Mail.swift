@preconcurrency internal import SharedSDK

// MARK: - Mail
extension SharedScreenModelFactory {

    public func makeMailThreads(start: MailListStart) -> any MailThreadsScreenModel {
        SharedMailThreadsScreenModel(sdk.mail.threadsViewModel(start: start.shared))
    }

    public func makeMailThread(threadId: String) -> any MailThreadScreenModel {
        SharedMailThreadScreenModel(sdk.mail.threadViewModel(threadId: threadId))
    }

    public func makeMailCompose(start: MailComposeStart) -> any MailComposeScreenModel {
        SharedMailComposeScreenModel(sdk.mail.composeViewModel(start: start.shared))
    }

    public func makeMailFolders() -> any MailFoldersScreenModel {
        SharedMailFoldersScreenModel(sdk.mail.foldersViewModel())
    }
}
