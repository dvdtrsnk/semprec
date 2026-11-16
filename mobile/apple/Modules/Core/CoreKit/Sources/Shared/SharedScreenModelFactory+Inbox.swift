@preconcurrency internal import SharedSDK

// MARK: - Inbox
extension SharedScreenModelFactory {

    public func makeInbox() -> any InboxScreenModel {
        SharedInboxScreenModel(sdk.inbox.inboxViewModel())
    }
}
