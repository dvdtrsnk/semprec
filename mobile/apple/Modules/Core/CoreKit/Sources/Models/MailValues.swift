import Foundation

/// The boxes of the mail thread list; a folder or an account narrows one of them.
public enum MailListBox: Equatable, Hashable, Sendable {

    case inbox
    case flagged
    case sempDrafts
}

/// The thread list a screen starts with: everything of the person, or the threads of an area, a project, a folder.
public struct MailListStart: Equatable, Hashable, Sendable {

    public var areaId: String?
    public var projectId: String?
    public var box: MailListBox
    public var mailboxId: String?
    public var folderId: String?

    public init(
        areaId: String? = nil,
        projectId: String? = nil,
        box: MailListBox = .inbox,
        mailboxId: String? = nil,
        folderId: String? = nil
    ) {
        self.areaId = areaId
        self.projectId = projectId
        self.box = box
        self.mailboxId = mailboxId
        self.folderId = folderId
    }
}

/// How the value of a thread, a file or a task relates to its source.
public enum MailLinkType: Equatable, Sendable {

    /// Taken over from its source until somebody changes it.
    case inherited
    /// Taken over once and changed since.
    case broken
    /// Computed from another item, never changed by hand.
    case derived
}

/// The state of a value that may follow another item; `sourceTitles` name what it follows.
public struct MailLinkInfo: Equatable, Sendable {

    public let type: MailLinkType
    public let sourceTitles: [String]
    public let brokenByAgent: Bool

    public init(type: MailLinkType, sourceTitles: [String], brokenByAgent: Bool) {
        self.type = type
        self.sourceTitles = sourceTitles
        self.brokenByAgent = brokenByAgent
    }
}

/// A value (a company, a project) with the link that ties it to its source, if it has one.
public struct MailLinkedValue: Equatable, Sendable {

    public let text: String?
    public let link: MailLinkInfo?

    public init(text: String?, link: MailLinkInfo?) {
        self.text = text
        self.link = link
    }
}

public enum MailReplyMode: Equatable, Sendable {

    case reply
    case replyAll
    case forward
}

/// What a compose screen starts from: a blank message, the reply to a message, or a saved draft.
public enum MailComposeStart: Equatable, Hashable, Sendable {

    case new
    /// A reply, reply-all or forward of `sourceEmailId`, sent from the mailbox `mailboxId` that received it.
    case reply(sourceEmailId: String, mailboxId: String, mode: MailReplyMode)
    case draft(draftId: String)
}

/// The progress of sending a message; `failed` keeps the draft so that sending again is possible.
public enum MailSendPhase: Equatable, Sendable {

    case idle
    case sending
    case sent
    case failed
}

/// What a mailbox is doing: in order, still downloading, failing, or waiting for the person to sign in again.
public enum MailAccountStatus: Equatable, Sendable {

    case ok
    case syncing
    case error
    case needsReauthorization
}
