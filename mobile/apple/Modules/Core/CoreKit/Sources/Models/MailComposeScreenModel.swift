import Foundation

public struct MailRecipient: Equatable, Sendable, Identifiable {

    public let name: String
    public let address: String

    public var id: String { address }

    public init(name: String, address: String) {
        self.name = name
        self.address = address
    }
}

/// A mailbox the message can be sent from, with the address it is sent as.
public struct MailSender: Equatable, Sendable, Identifiable {

    public let mailboxId: String
    public let name: String
    public let address: String

    public var id: String { mailboxId }

    public init(mailboxId: String, name: String, address: String) {
        self.mailboxId = mailboxId
        self.name = name
        self.address = address
    }
}

public struct MailSuggestion: Equatable, Sendable, Identifiable {

    public let name: String
    public let address: String
    public let relationship: String?

    public var id: String { address }

    public init(name: String, address: String, relationship: String?) {
        self.name = name
        self.address = address
        self.relationship = relationship
    }
}

public enum MailComposePhase: Equatable, Sendable {

    case loading
    case editing
    case failure(FailureKind?)
}

/// A message being written. The subject and the text belong to the screen's fields: `initialSubject` and
/// `initialBody` seed them once when the draft is ready, and the fields come back with `send`.
public struct MailComposeState: Equatable, Sendable {

    public var phase: MailComposePhase
    public var senders: [MailSender]
    public var senderId: String?
    public var toRecipients: [MailRecipient]
    public var ccRecipients: [MailRecipient]
    public var initialSubject: String
    public var initialBody: String
    public var suggestions: [MailSuggestion]
    public var invalidAddress: Bool
    public var sendPhase: MailSendPhase
    public var sendFailure: FailureKind?
    public var sentFrom: String?
    public var discardFailed: Bool

    public init(
        phase: MailComposePhase = .loading,
        senders: [MailSender] = [],
        senderId: String? = nil,
        toRecipients: [MailRecipient] = [],
        ccRecipients: [MailRecipient] = [],
        initialSubject: String = "",
        initialBody: String = "",
        suggestions: [MailSuggestion] = [],
        invalidAddress: Bool = false,
        sendPhase: MailSendPhase = .idle,
        sendFailure: FailureKind? = nil,
        sentFrom: String? = nil,
        discardFailed: Bool = false
    ) {
        self.phase = phase
        self.senders = senders
        self.senderId = senderId
        self.toRecipients = toRecipients
        self.ccRecipients = ccRecipients
        self.initialSubject = initialSubject
        self.initialBody = initialBody
        self.suggestions = suggestions
        self.invalidAddress = invalidAddress
        self.sendPhase = sendPhase
        self.sendFailure = sendFailure
        self.sentFrom = sentFrom
        self.discardFailed = discardFailed
    }
}

public enum MailComposeAction: Equatable, Sendable {

    case retry
    case searchContacts(String)
    case addRecipient(name: String, address: String)
    /// A typed address; text that is no address raises `invalidAddress`.
    case addAddress(String)
    case removeRecipient(address: String)
    case selectSender(mailboxId: String)
    case send(subject: String, body: String)
    /// Leaves; a draft that was made only for this message is discarded first.
    case cancel
}

public enum MailComposeEffect: Equatable, Sendable {

    case close
}

public typealias MailComposeScreenModel = ScreenModel<MailComposeState, MailComposeAction, MailComposeEffect>

/// Compose screen model for previews and tests; it never starts the Kotlin runtime.
public typealias ScriptedMailComposeScreenModel =
    ScriptedScreenModel<MailComposeState, MailComposeAction, MailComposeEffect>
