import Foundation
@preconcurrency internal import SharedSDK

/// Inbox captures for the app's system entry points (the App Intents of the Action button), over the Kotlin
/// `InboxCaptureSDK`: no window, no warm-up and no sync socket
/// (docs/adr/2026-11-27-apple-system-entry-points-run-in-the-app-over-a-headless-sdk.md). It signs in with the
/// Keychain session of the windows and keeps its data in their `Application Support/Offline`, so it reads the types
/// they kept and its captures wait in the device's capture outbox until the server takes them. A refused session is
/// left for the next window to end. The app uses the one instance of the process, `shared`, so exactly one Kotlin SDK
/// and one HTTP client serve every system entry point and the background sending
/// (docs/adr/2026-11-27-apple-app-sends-waiting-inbox-captures-from-background-tasks.md).
@MainActor
public final class InboxShortcutCapture {

    // MARK: - Types
    /// What `types()` answers: the Inbox item types, or why they could not be read.
    public enum Types: Equatable, Sendable {
        case loaded([InboxCaptureType])
        case failed(Failed)
    }

    /// What `capturesWait()` answers: a capture of the person signed in waits, none does, or the count failed and it
    /// is not known. Who decides on the answer treats `.unknown` as possibly waiting.
    public enum Waiting: Equatable, Sendable {
        case waiting
        case nothing
        case unknown
    }

    /// A file kept with a capture: its name, its media type, its bytes as Base64 text and where it came from.
    public struct File: Equatable, Sendable {

        public let filename: String
        public let mimeType: String
        public let base64: String
        public let source: InboxCaptureSource

        public init(filename: String, mimeType: String, base64: String, source: InboxCaptureSource) {
            self.filename = filename
            self.mimeType = mimeType
            self.base64 = base64
            self.source = source
        }
    }

    // MARK: - Shared
    /// The one bridge of the process, over the Keychain session and the offline directory of the windows.
    public static let shared = InboxShortcutCapture()

    // MARK: - Dependencies
    private let sdk: SharedSDK.InboxCaptureSDK

    // MARK: - Init
    /// Over the Keychain session and the offline directory of the windows' `SharedScreenModelFactory`; the app uses
    /// `shared` rather than making another.
    private convenience init() {
        self.init(sessionStorage: KeychainSessionStorage(), dataDirectory: OfflineDirectory.path())
    }

    /// Over `sessionStorage` and `dataDirectory`; CoreKitTests use a session in memory and a directory of their own.
    init(sessionStorage: any SharedSDK.SessionStorage, dataDirectory: String) {
        sdk = SharedSDK.InboxCaptureSDK(sessionStorage: sessionStorage, dataDirectory: dataDirectory)
    }

    // MARK: - Methods
    /// Whether a session is stored on this device.
    public var isSignedIn: Bool {
        sdk.signedIn()
    }

    /// The active Inbox item types in the server's order, from the server or, when it cannot answer, from what the
    /// device kept. A call that throws (it was cancelled) answers an unexpected failure.
    public func types() async -> Types {
        guard let answer = try? await sdk.types() else { return .failed(Failed(kind: nil)) }
        return Self.types(answer)
    }

    /// Keeps a capture of `text` on `day` (`yyyy-MM-dd`) at `time` (`HH:mm`) with the type `typeId`, nil for none, and
    /// `file`, nil for none, in the device's outbox; nil once it is kept, or why it is not: `.invalidData` for a blank
    /// text without a file or a file whose Base64 does not decode, `.unauthorized` when nobody is signed in,
    /// `.unavailable` when the device could not write it.
    public func capture(text: String, day: String, time: String, typeId: String?, file: File?) async -> Failed? {
        let input: SharedSDK.InboxCaptureFileInput? = if let file { Self.file(file) } else { nil }
        guard let answer = try? await sdk.capture(text: text, day: day, time: time, typeId: typeId, file: input)
        else { return Failed(kind: nil) }
        return Self.capture(answer)
    }

    /// Sends the captures that wait now and answers whether none of the person signed in is left. Cancelling the
    /// calling task stops the sending, unless another trigger of the outbox (a capture just added, a window, a retry
    /// after a backoff) waits for the same round; it loses no capture.
    public func send() async -> Bool {
        guard let sent = try? await sdk.send() else { return false }
        return sent.boolValue
    }

    /// Whether a capture of the person signed in waits for the server, counted on the device now: `.nothing` when
    /// nobody is signed in or no window has kept the person of the session, `.unknown` when the count failed or the
    /// call throws (it was cancelled).
    public func capturesWait() async -> Waiting {
        guard let waits = try? await sdk.capturesWait() else { return .unknown }
        return Self.waiting(waits)
    }
}

// MARK: - Mapping
// Pure functions from the Kotlin answers, internal so that CoreKitTests check every branch with Kotlin values.
extension InboxShortcutCapture {

    static func types(_ answer: any SharedSDK.InboxCaptureTypesAnswer) -> Types {
        switch onEnum(of: answer) {
        case .loaded(let loaded):
            .loaded(loaded.types.map { InboxCaptureType(id: $0.id, label: $0.label, emoji: $0.emoji) })
        case .refused(let refused):
            .failed(Failed(refused.failure))
        }
    }

    /// `sending`: the Kotlin value is made here for the one call that takes it, so it can cross into that call.
    static func file(_ file: File) -> sending SharedSDK.InboxCaptureFileInput {
        SharedSDK.InboxCaptureFileInput(
            filename: file.filename,
            mimeType: file.mimeType,
            base64: file.base64,
            source: SharedInboxCaptureScreenModel.source(file.source)
        )
    }

    static func capture(_ answer: any SharedSDK.InboxCaptureAnswer) -> Failed? {
        switch onEnum(of: answer) {
        case .kept: nil
        case .refused(let refused): Failed(refused.failure)
        }
    }

    static func waiting(_ answer: SharedSDK.InboxCapturesWaiting) -> Waiting {
        switch answer {
        case .waiting: .waiting
        case .nothing: .nothing
        case .unknown: .unknown
        }
    }
}
