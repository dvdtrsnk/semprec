import AVFoundation
import Foundation
@preconcurrency internal import SharedSDK
import UniformTypeIdentifiers

/// The shared layer's `AudioRecorder` on the device microphone: an `AVAudioRecorder` that writes AAC into a file in the
/// temporary folder. It decides nothing; when to ask, start, stop and upload is the Kotlin `RecorderViewModel`. Every
/// call comes on the main thread.
@MainActor
final class DeviceAudioRecorder: NSObject {

    // MARK: - Properties
    private var recorder: AVAudioRecorder?
    private var startedAt: Date?
    private let folder: URL

    // MARK: - Init
    override init() {
        folder = FileManager.default.temporaryDirectory.appendingPathComponent("recordings", isDirectory: true)
        super.init()
    }
}

// MARK: - Protocol conformance
extension DeviceAudioRecorder: @preconcurrency SharedSDK.AudioRecorder {

    func requestPermission(answer: @escaping (KotlinBoolean) -> Void) {
        nonisolated(unsafe) let answer = answer
        AVAudioApplication.requestRecordPermission { granted in
            DispatchQueue.main.async { answer(KotlinBoolean(bool: granted)) }
        }
    }

    func start() -> Bool {
        cancel()
        guard AudioSessionConfiguration.activate(recording: true) else { return false }
        do {
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            let file = folder.appendingPathComponent("\(UUID().uuidString).m4a")
            let settings: [String: Any] = [
                AVFormatIDKey: Int(kAudioFormatMPEG4AAC),
                AVSampleRateKey: 44_100,
                AVNumberOfChannelsKey: 1,
                AVEncoderBitRateKey: 64_000
            ]
            let created = try AVAudioRecorder(url: file, settings: settings)
            created.isMeteringEnabled = true
            guard created.record() else { return false }
            recorder = created
            startedAt = Date()
            return true
        } catch {
            return false
        }
    }

    func pause() {
        recorder?.pause()
    }

    func resume() {
        recorder?.record()
    }

    func stop() -> SharedSDK.CapturedAudio? {
        guard let recorder else { return nil }
        let seconds = recorder.currentTime
        recorder.stop()
        let started = startedAt ?? Date()
        self.recorder = nil
        startedAt = nil
        guard seconds > 0 else {
            try? FileManager.default.removeItem(at: recorder.url)
            return nil
        }
        return Self.audio(at: recorder.url, started: started, seconds: seconds)
    }

    func cancel() {
        guard let recorder else { return }
        recorder.stop()
        recorder.deleteRecording()
        self.recorder = nil
        startedAt = nil
    }

    func delete(audio: SharedSDK.CapturedAudio) {
        try? FileManager.default.removeItem(atPath: audio.path)
    }

    func elapsedSeconds() -> Double {
        recorder?.currentTime ?? 0
    }

    func level() -> Float {
        guard let recorder, recorder.isRecording else { return 0 }
        recorder.updateMeters()
        // Average power is decibels from -160 to 0; a person's voice sits in the upper part of that range.
        let decibels = max(recorder.averagePower(forChannel: 0), Self.floorDecibels)
        return (decibels - Self.floorDecibels) / -Self.floorDecibels
    }

    func importFile(path: String) -> SharedSDK.CapturedAudio? {
        let source = URL(fileURLWithPath: path)
        guard let type = UTType(filenameExtension: source.pathExtension),
              type.conforms(to: .audio) || type.conforms(to: .movie) || type.conforms(to: .video),
              let mime = type.preferredMIMEType else { return nil }
        let copy = folder.appendingPathComponent("\(UUID().uuidString).\(source.pathExtension)")
        do {
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            try FileManager.default.copyItem(at: source, to: copy)
        } catch {
            return nil
        }
        let created = (try? source.resourceValues(forKeys: [.creationDateKey]))?.creationDate ?? Date()
        let seconds = (try? AVAudioPlayer(contentsOf: copy))?.duration ?? 0
        return SharedSDK.CapturedAudio(
            path: copy.path,
            fileName: Self.headerSafe(source.lastPathComponent),
            mimeType: mime,
            recordedAt: Self.timestamp(created),
            durationSeconds: Int32(seconds.isFinite ? seconds : 0)
        )
    }
}

// MARK: - Private
private extension DeviceAudioRecorder {

    static let floorDecibels: Float = -60
    static let fileNameBytes = 150

    /// The name as an HTTP header can carry it: ASCII only and short.
    static func headerSafe(_ name: String) -> String {
        let ascii = name.unicodeScalars.map { $0.isASCII ? Character($0) : "_" }
        return String(ascii.prefix(fileNameBytes))
    }

    static func audio(at url: URL, started: Date, seconds: Double) -> SharedSDK.CapturedAudio {
        SharedSDK.CapturedAudio(
            path: url.path,
            fileName: url.lastPathComponent,
            mimeType: "audio/mp4",
            recordedAt: timestamp(started),
            durationSeconds: Int32(seconds)
        )
    }

    /// An ISO date-time with the offset of the device's time zone, as the server's upload route reads it.
    static func timestamp(_ date: Date) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.timeZone = .current
        formatter.formatOptions = [.withInternetDateTime]
        return formatter.string(from: date)
    }
}
