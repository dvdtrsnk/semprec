import Foundation
import UniformTypeIdentifiers

/// A file the person picked to capture, read into the form the shared ViewModel takes: its name, its media type and
/// its bytes as Base64 text.
struct CaptureFile: Equatable, Sendable {

    // MARK: - Properties
    let filename: String
    let mimeType: String
    let base64: String

    // MARK: - Methods
    /// Reads the file at `url`, which may be outside the app's sandbox and then needs its security scope.
    static func read(_ url: URL) throws -> CaptureFile {
        let scoped = url.startAccessingSecurityScopedResource()
        defer { if scoped { url.stopAccessingSecurityScopedResource() } }
        let data = try Data(contentsOf: url)
        let type = UTType(filenameExtension: url.pathExtension)
        return CaptureFile(
            filename: url.lastPathComponent,
            mimeType: type?.preferredMIMEType ?? "application/octet-stream",
            base64: data.base64EncodedString()
        )
    }

    /// A photo's bytes, named for the moment it was picked, as the image type its data starts with says.
    static func photo(_ data: Data, type: UTType?, named name: String) -> CaptureFile {
        let type = type ?? .jpeg
        let suffix = type.preferredFilenameExtension.map { ".\($0)" } ?? ""
        return CaptureFile(
            filename: name + suffix,
            mimeType: type.preferredMIMEType ?? "image/jpeg",
            base64: data.base64EncodedString()
        )
    }
}
