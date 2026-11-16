@preconcurrency internal import SharedSDK

// MARK: - Boxes and starts
extension MailListBox {

    init(_ box: SharedSDK.MailListBox) {
        switch box {
        case .inbox: self = .inbox
        case .flagged: self = .flagged
        case .sempDrafts: self = .sempDrafts
        }
    }

    var shared: SharedSDK.MailListBox {
        switch self {
        case .inbox: .inbox
        case .flagged: .flagged
        case .sempDrafts: .sempDrafts
        }
    }
}

extension MailListStart {

    init(_ start: SharedSDK.MailListStart) {
        self.init(
            areaId: start.areaId,
            projectId: start.projectId,
            box: MailListBox(start.box),
            mailboxId: start.mailboxId,
            folderId: start.folderId
        )
    }

    var shared: SharedSDK.MailListStart {
        SharedSDK.MailListStart(
            areaId: areaId,
            projectId: projectId,
            box: box.shared,
            mailboxId: mailboxId,
            folderId: folderId
        )
    }
}

// MARK: - Reply and compose
extension MailReplyMode {

    var shared: SharedSDK.MailReplyMode {
        switch self {
        case .reply: .reply
        case .replyAll: .replyAll
        case .forward: .forward
        }
    }

    init(_ mode: SharedSDK.MailReplyMode) {
        switch mode {
        case .reply: self = .reply
        case .replyAll: self = .replyAll
        case .forward: self = .forward
        }
    }
}

extension MailComposeStart {

    init(_ start: any SharedSDK.MailComposeStart) {
        switch onEnum(of: start) {
        case .new: self = .new
        case .reply(let reply):
            self = .reply(
                sourceEmailId: reply.sourceEmailId,
                mailboxId: reply.mailboxId,
                mode: MailReplyMode(reply.mode)
            )
        case .draft(let draft): self = .draft(draftId: draft.draftId)
        }
    }

    var shared: any SharedSDK.MailComposeStart {
        switch self {
        case .new: SharedSDK.MailComposeStartNew.shared
        case .reply(let sourceEmailId, let mailboxId, let mode):
            SharedSDK.MailComposeStartReply(sourceEmailId: sourceEmailId, mailboxId: mailboxId, mode: mode.shared)
        case .draft(let draftId): SharedSDK.MailComposeStartDraft(draftId: draftId)
        }
    }
}

// MARK: - Sending and status
extension MailSendPhase {

    init(_ phase: SharedSDK.MailSendPhase) {
        switch phase {
        case .idle: self = .idle
        case .sending: self = .sending
        case .sent: self = .sent
        case .failed: self = .failed
        }
    }
}

extension MailAccountStatus {

    init(_ status: SharedSDK.MailAccountStatus) {
        switch status {
        case .ok: self = .ok
        case .syncing: self = .syncing
        case .error: self = .error
        case .needsReauthorization: self = .needsReauthorization
        }
    }
}

// MARK: - Links
extension MailLinkInfo {

    init(_ info: SharedSDK.MailLinkInfo) {
        let type: MailLinkType
        switch info.type {
        case .inherited: type = .inherited
        case .broken: type = .broken
        case .derived: type = .derived
        }
        self.init(type: type, sourceTitles: info.sourceTitles, brokenByAgent: info.brokenByAgent)
    }
}

extension MailLinkedValue {

    init(_ value: SharedSDK.MailLinkedValue) {
        self.init(text: value.text, link: value.link.map(MailLinkInfo.init))
    }
}
