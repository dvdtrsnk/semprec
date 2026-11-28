import CoreKit
import QuickLook
import SwiftUI

/// Shows the attachment of a card's source the person opened in Quick Look once its file is ready, and why it could
/// not be opened when it failed. Closing either ends the preview through `close`.
struct InboxAttachmentPreview: ViewModifier {

    // MARK: - Dependencies
    let preview: AttachmentPreview?
    let close: () -> Void

    // MARK: - Body
    func body(content: Content) -> some View {
        content
            .quickLookPreview(url)
            .alert(
                Text("inbox.attachment.failed", bundle: .module),
                isPresented: failureShown,
                presenting: preview?.failure
            ) { _ in
                Button(role: .cancel, action: close) { Text("inbox.dismiss", bundle: .module) }
            } message: { failure in
                Text(FailureKind.message(for: failure.kind))
            }
    }
}

// MARK: - Private
private extension InboxAttachmentPreview {

    var url: Binding<URL?> {
        Binding(get: { preview?.url }, set: { if $0 == nil { close() } })
    }

    var failureShown: Binding<Bool> {
        Binding(get: { preview?.failure != nil }, set: { if !$0 { close() } })
    }
}

// MARK: - View
extension View {

    /// Presents `preview` as `InboxAttachmentPreview` does.
    func inboxAttachmentPreview(_ preview: AttachmentPreview?, close: @escaping () -> Void) -> some View {
        modifier(InboxAttachmentPreview(preview: preview, close: close))
    }
}
