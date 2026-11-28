import CoreKit
import QuickLook
import SwiftUI

/// Shows the Inbox attachment the person opened in Quick Look once its file is ready, and why it could not be opened
/// when it failed. Closing either ends the preview through `close`.
struct JournalAttachmentPreview: ViewModifier {

    // MARK: - Dependencies
    let preview: AttachmentPreview?
    let close: () -> Void

    // MARK: - Body
    func body(content: Content) -> some View {
        content
            .quickLookPreview(url)
            .alert(
                Text("journal.attachment.failed", bundle: .module),
                isPresented: failureShown,
                presenting: preview?.failure
            ) { _ in
                Button(role: .cancel, action: close) { Text("journal.problem.dismiss", bundle: .module) }
            } message: { failure in
                Text(FailureKind.message(for: failure.kind))
            }
    }
}

// MARK: - Private
private extension JournalAttachmentPreview {

    var url: Binding<URL?> {
        Binding(get: { preview?.url }, set: { if $0 == nil { close() } })
    }

    var failureShown: Binding<Bool> {
        Binding(get: { preview?.failure != nil }, set: { if !$0 { close() } })
    }
}

// MARK: - View
extension View {

    /// Presents `preview` as `JournalAttachmentPreview` does.
    func journalAttachmentPreview(_ preview: AttachmentPreview?, close: @escaping () -> Void) -> some View {
        modifier(JournalAttachmentPreview(preview: preview, close: close))
    }
}
