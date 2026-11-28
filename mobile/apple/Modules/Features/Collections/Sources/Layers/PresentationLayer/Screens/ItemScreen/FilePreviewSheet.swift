import CoreKit
import DesignSystem
import SwiftUI

/// A file of an item downloaded in full: an image or the first page of a PDF, else what is known about the file,
/// and a way to hand it to another app.
struct FilePreviewSheet: View {

    // MARK: - Dependencies
    let preview: PreviewView
    let format: FieldFormat
    let send: (ItemAction) -> Void

    // MARK: - State
    @State private var shareURL: URL?

    // MARK: - Body
    var body: some View {
        NavigationStack {
            content
                .navigationTitle(preview.filename ?? preview.mimeType)
                .inlineNavigationTitle()
                .toolbar {
                    ToolbarItem(placement: .confirmationAction) {
                        Button { send(.preview(.close)) } label: { Text("preview.done", bundle: .module) }
                    }
                    if let shareURL {
                        PlainToolbarItem(placement: .primaryAction) { ShareLink(item: shareURL) }
                    }
                }
        }
        .task(id: preview.status) { shareURL = temporaryFile }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier(CollectionsIdentifiers.previewSheet)
    }
}

// MARK: - Subviews
private extension FilePreviewSheet {

    @ViewBuilder var content: some View {
        switch preview.status {
        case .loading:
            StatusView(.loading)
        case .error:
            StatusView(.failure(message: Text(FailureKind.message(for: preview.failure)), retry: {
                send(.preview(.close))
            }))
        case .ready:
            if let image = decoded {
                ScrollView([.horizontal, .vertical]) {
                    Image(decorative: image, scale: 1).resizable().scaledToFit().padding(Theme.Spacing.medium)
                }
            } else {
                StatusView(.empty(message: Text("preview.unsupported", bundle: .module), systemImage: "doc"))
            }
        }
    }

    var data: Data? {
        preview.base64.flatMap { Data(base64Encoded: $0) }
    }

    var decoded: CGImage? {
        data.flatMap { PreviewImage.image(from: $0, mimeType: preview.mimeType) }
    }

    /// The file written to the temporary directory under its own name, so another app receives a named file.
    var temporaryFile: URL? {
        guard preview.status == .ready, let data else { return nil }
        let name = (preview.filename ?? preview.blobId).replacingOccurrences(of: "/", with: "-")
        let url = FileManager.default.temporaryDirectory.appendingPathComponent(name)
        return (try? data.write(to: url, options: .atomic)) == nil ? nil : url
    }
}
