import Foundation

/// An Inbox item type a capture can have.
public struct InboxCaptureType: Equatable, Sendable, Identifiable {

    public let id: String
    public let label: String
    public let emoji: String

    public init(id: String, label: String, emoji: String) {
        self.id = id
        self.label = label
        self.emoji = emoji
    }
}

/// The file attached to the capture being written.
public struct InboxCaptureAttachment: Equatable, Sendable {

    public let filename: String
    public let mimeType: String
    public let byteSize: Int

    public init(filename: String, mimeType: String, byteSize: Int) {
        self.filename = filename
        self.mimeType = mimeType
        self.byteSize = byteSize
    }
}

/// Where an attached file came from.
public enum InboxCaptureSource: Equatable, Sendable {

    case camera
    case photoLibrary
    case files
}

public enum InboxCapturePhase: Equatable, Sendable {

    case idle
    case loading
    case ready
    case failed
}

/// The capture row of the diary's Inbox: the item types (loaded when the picker first opens), the picked type, the
/// attached file, whether a capture is being sent and why the last one was not.
public struct InboxCaptureState: Equatable, Sendable {

    public var types: [InboxCaptureType]
    public var typesPhase: InboxCapturePhase
    public var typeId: String?
    public var attachment: InboxCaptureAttachment?
    public var sending: Bool
    public var failure: Failed?

    public init(
        types: [InboxCaptureType] = [],
        typesPhase: InboxCapturePhase = .idle,
        typeId: String? = nil,
        attachment: InboxCaptureAttachment? = nil,
        sending: Bool = false,
        failure: Failed? = nil
    ) {
        self.types = types
        self.typesPhase = typesPhase
        self.typeId = typeId
        self.attachment = attachment
        self.sending = sending
        self.failure = failure
    }
}

public enum InboxCaptureAction: Equatable, Sendable {

    case loadTypes
    /// Picks the type of the capture; nil for none.
    case pickType(String?)
    /// Attaches a file given as Base64 text of its bytes.
    case attach(filename: String, mimeType: String, base64: String, source: InboxCaptureSource)
    case removeAttachment
    /// Sends `text`, captured on `day` (`YYYY-MM-DD`) at `time` (`HH:mm`).
    case submit(text: String, day: String, time: String)
    case dismissFailure
}

public enum InboxCaptureEffect: Equatable, Sendable {

    /// The capture is in the Inbox.
    case captured
}

public typealias InboxCaptureScreenModel = ScreenModel<InboxCaptureState, InboxCaptureAction, InboxCaptureEffect>

/// A capture row that never starts the Kotlin runtime, for previews and feature tests.
public typealias ScriptedInboxCaptureScreenModel =
    ScriptedScreenModel<InboxCaptureState, InboxCaptureAction, InboxCaptureEffect>
