import AVFoundation

/// The one place where iOS and macOS differ for audio: iOS shares one audio session between the apps and wants it
/// configured for what the app does, macOS has no such session.
enum AudioSessionConfiguration {

    /// Prepares the device for `recording` (the microphone is open) or for playing only. Returns false when the
    /// system refuses.
    @discardableResult
    static func activate(recording: Bool) -> Bool {
        #if os(iOS)
        let session = AVAudioSession.sharedInstance()
        do {
            try session.setCategory(recording ? .playAndRecord : .playback, mode: .default)
            try session.setActive(true)
            return true
        } catch {
            return false
        }
        #else
        return true
        #endif
    }
}
