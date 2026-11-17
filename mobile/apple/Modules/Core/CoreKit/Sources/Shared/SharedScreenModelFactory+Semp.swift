@preconcurrency internal import SharedSDK

// MARK: - Semp
extension SharedScreenModelFactory {

    public func makeSempThread(
        start: SempThreadStart,
        threadId: String?,
        inboxItemId: String?,
        title: String?,
        meta: String?
    ) -> any SempThreadScreenModel {
        SharedSempThreadScreenModel(
            sdk.semp.threadViewModel(
                start: start.shared,
                threadId: threadId,
                inboxItemId: inboxItemId,
                title: title,
                meta: meta
            )
        )
    }

    public func makeSempChats() -> any SempChatsScreenModel {
        SharedSempChatsScreenModel(sdk.semp.chatsViewModel())
    }

    public func makeSempStatus() -> any SempStatusScreenModel {
        SharedSempStatusScreenModel(sdk.semp.statusViewModel())
    }

    public func makeSempRun(runId: String, messageId: String?) -> any SempRunScreenModel {
        SharedSempRunScreenModel(sdk.semp.runViewModel(runId: runId, messageId: messageId))
    }

    public func makeSempApprovals() -> any SempApprovalsScreenModel {
        SharedSempApprovalsScreenModel(sdk.semp.approvalsViewModel())
    }

    public func makeSempProjectAgent(projectId: String) -> any SempProjectAgentScreenModel {
        SharedSempProjectAgentScreenModel(sdk.semp.projectAgentViewModel(projectId: projectId))
    }

    public func makeSempBubble() -> any SempBubbleScreenModel {
        SharedSempBubbleScreenModel(sdk.semp.bubbleViewModel())
    }
}
