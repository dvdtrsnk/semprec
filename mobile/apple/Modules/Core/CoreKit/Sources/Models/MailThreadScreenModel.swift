import Foundation

/// A file attached to a message; the project it is stored under follows the thread's until somebody changes it.
public struct MailAttachmentItem: Equatable, Sendable, Identifiable {

    public let filename: String
    public let contentType: String
    public let byteSize: Int64
    public let project: MailLinkedValue

    public var id: String { filename }

    public init(filename: String, contentType: String, byteSize: Int64, project: MailLinkedValue) {
        self.filename = filename
        self.contentType = contentType
        self.byteSize = byteSize
        self.project = project
    }
}

public struct MailMessageItem: Equatable, Sendable, Identifiable {

    public let emailId: String
    public let fromName: String
    public let fromAddress: String
    public let own: Bool
    public let toNames: [String]
    public let date: String?
    public let bodyText: String
    public let attachments: [MailAttachmentItem]
    public let expanded: Bool

    public var id: String { emailId }

    public init(
        emailId: String,
        fromName: String,
        fromAddress: String,
        own: Bool = false,
        toNames: [String] = [],
        date: String? = nil,
        bodyText: String = "",
        attachments: [MailAttachmentItem] = [],
        expanded: Bool = false
    ) {
        self.emailId = emailId
        self.fromName = fromName
        self.fromAddress = fromAddress
        self.own = own
        self.toNames = toNames
        self.date = date
        self.bodyText = bodyText
        self.attachments = attachments
        self.expanded = expanded
    }
}

/// A task made from the thread.
public struct MailTaskItem: Equatable, Sendable, Identifiable {

    public let id: String
    public let name: String
    public let date: String?
    public let done: Bool
    public let project: MailLinkedValue
    public let peopleNames: [String]
    public let peopleLink: MailLinkInfo?

    public init(
        id: String,
        name: String,
        date: String? = nil,
        done: Bool = false,
        project: MailLinkedValue = MailLinkedValue(text: nil, link: nil),
        peopleNames: [String] = [],
        peopleLink: MailLinkInfo? = nil
    ) {
        self.id = id
        self.name = name
        self.date = date
        self.done = done
        self.project = project
        self.peopleNames = peopleNames
        self.peopleLink = peopleLink
    }
}

/// The reply Semp prepared as a draft of the thread; `body` is its text, which the person may change before sending.
public struct MailSempDraft: Equatable, Sendable {

    public let id: String
    public let body: String
    public let recipients: [String]

    public init(id: String, body: String, recipients: [String]) {
        self.id = id
        self.body = body
        self.recipients = recipients
    }
}

public enum MailThreadPhase: Equatable, Sendable {

    case loading
    case content
    case failure(FailureKind?)
}

/// One thread. `archivedOrTrashed` is true when the toolbar offers to restore it; `actionFailed` says a flag, move,
/// task or reload did not go through. `sendRefusal` and `actionRefusal` name the reason the server gave for refusing
/// the send or the flag or move.
public struct MailThreadState: Equatable, Sendable {

    public var phase: MailThreadPhase
    public var refreshing: Bool
    public var subject: String
    public var senderName: String
    public var senderAddress: String
    public var senderRelationship: String?
    public var mailboxNames: [String]
    public var messageCount: Int
    public var flagged: Bool
    public var company: MailLinkedValue
    public var project: MailLinkedValue
    public var messages: [MailMessageItem]
    public var tasks: [MailTaskItem]
    public var draft: MailSempDraft?
    public var sendPhase: MailSendPhase
    public var sendFailure: FailureKind?
    public var sendRefusal: MailRefusal?
    public var sentFrom: String?
    public var archivedOrTrashed: Bool
    public var canReply: Bool
    public var acting: Bool
    public var creatingTask: Bool
    public var actionFailed: Bool
    public var actionRefusal: MailRefusal?

    public init(
        phase: MailThreadPhase = .loading,
        refreshing: Bool = false,
        subject: String = "",
        senderName: String = "",
        senderAddress: String = "",
        senderRelationship: String? = nil,
        mailboxNames: [String] = [],
        messageCount: Int = 0,
        flagged: Bool = false,
        company: MailLinkedValue = MailLinkedValue(text: nil, link: nil),
        project: MailLinkedValue = MailLinkedValue(text: nil, link: nil),
        messages: [MailMessageItem] = [],
        tasks: [MailTaskItem] = [],
        draft: MailSempDraft? = nil,
        sendPhase: MailSendPhase = .idle,
        sendFailure: FailureKind? = nil,
        sendRefusal: MailRefusal? = nil,
        sentFrom: String? = nil,
        archivedOrTrashed: Bool = false,
        canReply: Bool = false,
        acting: Bool = false,
        creatingTask: Bool = false,
        actionFailed: Bool = false,
        actionRefusal: MailRefusal? = nil
    ) {
        self.phase = phase
        self.refreshing = refreshing
        self.subject = subject
        self.senderName = senderName
        self.senderAddress = senderAddress
        self.senderRelationship = senderRelationship
        self.mailboxNames = mailboxNames
        self.messageCount = messageCount
        self.flagged = flagged
        self.company = company
        self.project = project
        self.messages = messages
        self.tasks = tasks
        self.draft = draft
        self.sendPhase = sendPhase
        self.sendFailure = sendFailure
        self.sendRefusal = sendRefusal
        self.sentFrom = sentFrom
        self.archivedOrTrashed = archivedOrTrashed
        self.canReply = canReply
        self.acting = acting
        self.creatingTask = creatingTask
        self.actionFailed = actionFailed
        self.actionRefusal = actionRefusal
    }
}

public enum MailThreadMove: Equatable, Sendable {

    case archive
    case trash
    case restore
}

/// What the thread screen asks the app to show: Semp's draft or a reply in the editor, or a task of the thread.
public enum MailThreadTarget: Equatable, Sendable {

    case draft
    case reply(MailReplyMode)
    case task(taskId: String)
}

public enum MailThreadAction: Equatable, Sendable {

    case retry
    case refresh
    case toggleMessage(emailId: String)
    case toggleFlag
    case move(MailThreadMove)
    /// Sends Semp's draft with `body` as its text; a text other than the stored one is saved first.
    case sendDraft(body: String)
    case addTask
    case open(MailThreadTarget)
    case dismissFailure
}

public enum MailThreadEffect: Equatable, Sendable {

    /// The thread was moved away; the screen goes back.
    case close
    case compose(MailComposeStart)
    case openTask(taskId: String)
}

public typealias MailThreadScreenModel = ScreenModel<MailThreadState, MailThreadAction, MailThreadEffect>

/// Thread screen model for previews and tests; it never starts the Kotlin runtime.
public typealias ScriptedMailThreadScreenModel =
    ScriptedScreenModel<MailThreadState, MailThreadAction, MailThreadEffect>
