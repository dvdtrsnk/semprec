import Foundation

/// A file attached to an Inbox item; `name` is its file name when it has one, `mediaType` its MIME type.
public struct InboxAttachment: Equatable, Sendable, Identifiable {

    public let id: String
    public let name: String?
    public let mediaType: String?

    public init(id: String, name: String? = nil, mediaType: String? = nil) {
        self.id = id
        self.name = name
        self.mediaType = mediaType
    }
}

/// Where the attachment the person asked to see stands: its file is being made ready, it is the local file to
/// preview, or it could not be opened (`nil` for an unexpected failure).
public enum AttachmentPreviewPhase: Equatable, Sendable {

    case opening
    case open(URL)
    case failed(FailureKind?)
}

/// The attachment `attachmentId` the person asked to see.
public struct AttachmentPreview: Equatable, Sendable {

    public let attachmentId: String
    public let phase: AttachmentPreviewPhase

    public init(attachmentId: String, phase: AttachmentPreviewPhase) {
        self.attachmentId = attachmentId
        self.phase = phase
    }

    /// The file to preview, once it is ready.
    public var url: URL? {
        if case .open(let url) = phase { url } else { nil }
    }

    /// Why it could not be opened, once that is known; `nil` while it is being opened or shown.
    public var failure: Failed? {
        if case .failed(let kind) = phase { Failed(kind: kind) } else { nil }
    }

    /// The attachment being made ready, while it is.
    public var openingId: String? {
        phase == .opening ? attachmentId : nil
    }
}
