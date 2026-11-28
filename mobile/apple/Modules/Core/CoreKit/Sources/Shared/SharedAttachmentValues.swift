import Foundation
@preconcurrency internal import SharedSDK

// MARK: - InboxAttachment
extension InboxAttachment {

    init(_ attachment: SharedSDK.AttachmentState) {
        self.init(id: attachment.id, name: attachment.name, mediaType: attachment.mediaType)
    }
}

// MARK: - AttachmentPreview
extension AttachmentPreview {

    /// An open preview without a path has no file to show, which is an unexpected failure.
    init(_ preview: SharedSDK.AttachmentPreviewState) {
        let phase: AttachmentPreviewPhase = switch preview.phase {
        case .opening: .opening
        case .open: preview.path.map { .open(URL(fileURLWithPath: $0)) } ?? .failed(nil)
        case .failed: .failed(preview.failure.map(FailureKind.init))
        }
        self.init(attachmentId: preview.attachmentId, phase: phase)
    }
}
