import Foundation
import UniformTypeIdentifiers

/// A file the person picked to upload, read into the form the shared ViewModel takes: its name, its media type and
/// its bytes as Base64 text.
struct UploadFile: Equatable, Sendable {

    // MARK: - Properties
    let filename: String
    let mimeType: String
    let base64: String

    // MARK: - Methods
    /// Reads the file at `url`, which may be outside the app's sandbox and then needs its security scope.
    static func read(_ url: URL) throws -> UploadFile {
        let scoped = url.startAccessingSecurityScopedResource()
        defer { if scoped { url.stopAccessingSecurityScopedResource() } }
        let data = try Data(contentsOf: url)
        return UploadFile(
            filename: url.lastPathComponent,
            mimeType: mimeType(of: url),
            base64: data.base64EncodedString()
        )
    }

    /// The media type the file's extension stands for; the generic binary type when it stands for none.
    static func mimeType(of url: URL) -> String {
        UTType(filenameExtension: url.pathExtension)?.preferredMIMEType ?? "application/octet-stream"
    }
}
