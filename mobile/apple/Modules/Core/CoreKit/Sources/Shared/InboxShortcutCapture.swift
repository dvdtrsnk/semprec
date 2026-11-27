import Foundation
@preconcurrency internal import SharedSDK

/// Inbox captures for the app's system entry points (the App Intents of the Action button), over the Kotlin
/// `InboxCaptureSDK`: no window, no warm-up and no sync socket
/// (docs/adr/2026-11-27-apple-system-entry-points-run-in-the-app-over-a-headless-sdk.md). It signs in with the
/// Keychain session of the windows and keeps its data in their `Application Support/Offline`, so it reads the types
/// they kept and its captures wait in the device's capture outbox until the server takes them. A refused session is
/// left for the next window to end. Create one per intent run or query.
@MainActor
public final class InboxShortcutCapture {

    // MARK: - Types
    /// What `types()` answers: the Inbox item types, or why they could not be read.
    public enum Types: Equatable, Sendable {
        case loaded([InboxCaptureType])
        case failed(Failed)
    }

    // MARK: - Dependencies
    private let sdk: SharedSDK.InboxCaptureSDK

    // MARK: - Init
    /// Over the Keychain session and the offline directory of the windows' `SharedScreenModelFactory`.
    public convenience init() {
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

    /// Keeps a capture of `text` on `day` (`yyyy-MM-dd`) at `time` (`HH:mm`) with the type `typeId`, nil for none, in
    /// the device's outbox; nil once it is kept, or why it is not: `.invalidData` for a blank text, `.unauthorized`
    /// when nobody is signed in, `.unavailable` when the device could not write it.
    public func capture(text: String, day: String, time: String, typeId: String?) async -> Failed? {
        guard let answer = try? await sdk.capture(text: text, day: day, time: time, typeId: typeId, file: nil)
        else { return Failed(kind: nil) }
        return Self.capture(answer)
    }

    /// Sends the captures that wait now and answers whether none of the person signed in is left. Cancelling it stops
    /// only the waiting; the sending goes on in the background for as long as the process runs.
    public func send() async -> Bool {
        guard let sent = try? await sdk.send() else { return false }
        return sent.boolValue
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

    static func capture(_ answer: any SharedSDK.InboxCaptureAnswer) -> Failed? {
        switch onEnum(of: answer) {
        case .kept: nil
        case .refused(let refused): Failed(refused.failure)
        }
    }
}
