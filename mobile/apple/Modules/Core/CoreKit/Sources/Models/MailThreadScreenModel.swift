import Foundation

/// Saving an attachment into Files: not asked for, on its way, done on this screen, or failed and possible again.
public enum MailAttachmentSavePhase: Equatable, Sendable {

    case idle
    case saving
    case saved
    case failed
}

/// A file attached to a message; the project it is stored under follows the thread's until somebody changes it.
/// `fileItemId` is the Files item it is saved as, which opens it; without one it can be saved. `saveFailure` and
/// `saveUnavailable` say why the last save failed.
public struct MailAttachmentItem: Equatable, Sendable, Identifiable {

    public let attachmentId: String
    public let filename: String
    public let contentType: String
    public let byteSize: Int64
    public let project: MailLinkedValue
    public let fileItemId: String?
    public let savePhase: MailAttachmentSavePhase
    public let saveFailure: FailureKind?
    public let saveUnavailable: MailContentUnavailable?

    public var id: String { attachmentId }

    public init(
        attachmentId: String,
        filename: String,
        contentType: String,
        byteSize: Int64,
        project: MailLinkedValue,
        fileItemId: String? = nil,
        savePhase: MailAttachmentSavePhase = .idle,
        saveFailure: FailureKind? = nil,
        saveUnavailable: MailContentUnavailable? = nil
    ) {
        self.attachmentId = attachmentId
        self.filename = filename
        self.contentType = contentType
        self.byteSize = byteSize
        self.project = project
        self.fileItemId = fileItemId
        self.savePhase = savePhase
        self.saveFailure = saveFailure
        self.saveUnavailable = saveUnavailable
    }
}

/// Where the body of a message is: shown, only at the mail provider and not asked for yet, being fetched from it, or
/// not fetched and possible to ask for again.
public enum MailBodyPhase: Equatable, Sendable {

    case ready
    case remote
    case loading
    case failed
}

/// One message of the thread. `bodyText` is the body while `bodyPhase` is `.ready`, else empty; `preview` is the short
/// snippet the server keeps for every message. `bodyFailure` and `bodyUnavailable` say why the body was not fetched.
public struct MailMessageItem: Equatable, Sendable, Identifiable {

    public let emailId: String
    public let fromName: String
    public let fromAddress: String
    public let own: Bool
    public let toNames: [String]
    public let date: String?
    public let bodyText: String
    public let preview: String?
    public let bodyPhase: MailBodyPhase
    public let bodyFailure: FailureKind?
    public let bodyUnavailable: MailContentUnavailable?
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
        preview: String? = nil,
        bodyPhase: MailBodyPhase = .ready,
        bodyFailure: FailureKind? = nil,
        bodyUnavailable: MailContentUnavailable? = nil,
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
        self.preview = preview
        self.bodyPhase = bodyPhase
        self.bodyFailure = bodyFailure
        self.bodyUnavailable = bodyUnavailable
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

/// What the thread screen asks the app to show: Semp's draft or a reply in the editor, a task of the thread, or the
/// Files item of a saved attachment.
public enum MailThreadTarget: Equatable, Sendable {

    case draft
    case reply(MailReplyMode)
    case task(taskId: String)
    case file(fileItemId: String)
}

public enum MailThreadAction: Equatable, Sendable {

    case retry
    case refresh
    /// Opens or closes a message; opening one whose body is only at the mail provider fetches it.
    case toggleMessage(emailId: String)
    /// Fetches the body of a message that is only at the mail provider again, after it failed.
    case loadBody(emailId: String)
    /// Saves an attachment of a message into Files.
    case saveAttachment(emailId: String, attachmentId: String)
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
    /// Shows the Files item of a saved attachment, which previews the file and hands it to other apps.
    case openFile(fileItemId: String)
}

public typealias MailThreadScreenModel = ScreenModel<MailThreadState, MailThreadAction, MailThreadEffect>

/// Thread screen model for previews and tests; it never starts the Kotlin runtime.
public typealias ScriptedMailThreadScreenModel =
    ScriptedScreenModel<MailThreadState, MailThreadAction, MailThreadEffect>
