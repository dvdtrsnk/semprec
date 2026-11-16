/// Accessibility identifiers of the Semp feature's elements. Android has no Semp screens yet, so none is shared.
enum SempIdentifiers {

    // MARK: - Bubble
    static let bubble = "semp.bubble"
    static let bubbleToast = "semp.bubble.toast"
    static let grabber = "semp.grabber"

    // MARK: - Chat
    static let thread = "semp.thread"
    static let history = "semp.history"
    static let newChat = "semp.newChat"
    static let composer = "semp.composer"
    static let composerField = "semp.composer.field"
    static let send = "semp.send"
    static let notice = "semp.notice"
    static let noticeClose = "semp.notice.close"
    static let runAgain = "semp.runAgain"
    static let loadOlder = "semp.loadOlder"
    /// Followed by the entry id.
    static let entryPrefix = "semp.entry."
    /// Followed by the message id.
    static let runChipPrefix = "semp.run."
    /// Followed by the entry id.
    static let regenerate = "semp.regenerate"
    static let retryReply = "semp.retryReply"
    static let retrySend = "semp.retrySend"
    static let discardSend = "semp.discardSend"
    /// Followed by the suggestion's position.
    static let suggestionPrefix = "semp.suggestion."
    /// Followed by the attachment key.
    static let attachmentPrefix = "semp.attachment."

    // MARK: - Chats
    static let chats = "semp.chats"
    /// Followed by the thread id.
    static let chatRowPrefix = "semp.chats.row."
    static let chatsFilter = "semp.chats.filterPicker"
    static let chatsApprovals = "semp.chats.approvalsSection"

    // MARK: - Approvals
    static let approvals = "semp.approvals"
    static let approvalsTabs = "semp.approvals.tabs"
    /// Followed by the request id.
    static let approvalPrefix = "semp.approval."
    static let approve = "semp.approval.approveButton"
    static let reject = "semp.approval.rejectButton"
    static let approvalDetails = "semp.approval.details"

    // MARK: - Status
    static let status = "semp.status"
    /// Followed by the problem id.
    static let issuePrefix = "semp.status.issue."
    static let issueFix = "semp.status.fix"
    static let issueLink = "semp.status.link"
    static let history7 = "semp.status.history"

    // MARK: - Run
    static let run = "semp.run"
    static let runRetry = "semp.run.retryButton"
    static let runApprovals = "semp.run.approvals"

    // MARK: - Project agent
    static let projectAgent = "semp.projectAgent"
    static let saveState = "semp.projectAgent.saveState"
    static let driftAllow = "semp.projectAgent.driftAllow"
    static let driftForbid = "semp.projectAgent.driftForbid"
    static let driftDismiss = "semp.projectAgent.driftDismiss"
    /// Followed by the section name.
    static let sectionPrefix = "semp.projectAgent.section."
    /// Followed by the registration id.
    static let toolPrefix = "semp.projectAgent.tool."
    /// Followed by the task id.
    static let taskPrefix = "semp.projectAgent.task."
    /// Followed by the row id.
    static let runRowPrefix = "semp.projectAgent.run."
}
