@preconcurrency import AVFoundation
import Combine
import Foundation
import Synchronization

/// The guard's own alarm sound while the app is open: a loud repeating beep the app plays itself, on top of the
/// system's alarms, with AVAudioEngine. On iOS it plays in the playback category, which the silent switch does not
/// mute. The scene that owns it plays it only while that scene is the active one.
@MainActor
public final class DeviceAlarmBeep: ObservableObject {

    // MARK: - Properties
    private let engine = AVAudioEngine()
    private var isPlaying = false

    // MARK: - Init
    public init() {}

    // MARK: - Methods
    /// Plays the beep until the surrounding task is cancelled, which stops it; answers false at once when the system
    /// refuses, which leaves the system's alarms as the only sound.
    @discardableResult
    public func play() async -> Bool {
        guard start() else { return false }
        defer { stop() }
        // Cancelling the task is how the beep ends, so the error of the wait is not one to report.
        try? await Task.sleep(for: .seconds(24 * 3_600))
        return true
    }
}

// MARK: - Private
private extension DeviceAlarmBeep {

    func start() -> Bool {
        guard !isPlaying else { return true }
        guard AudioSessionConfiguration.activate(recording: false) else { return false }
        let format = engine.outputNode.inputFormat(forBus: 0)
        let source = AVAudioSourceNode(renderBlock: Self.beep(sampleRate: format.sampleRate))
        engine.attach(source)
        engine.connect(
            source,
            to: engine.mainMixerNode,
            format: AVAudioFormat(standardFormatWithSampleRate: format.sampleRate, channels: 1)
        )
        engine.mainMixerNode.outputVolume = 1
        do {
            try engine.start()
        } catch {
            engine.detach(source)
            return false
        }
        isPlaying = true
        return true
    }

    func stop() {
        guard isPlaying else { return }
        engine.stop()
        isPlaying = false
    }

    /// Two short 880 Hz beeps, then a pause, every second, as a square-ish wave that cuts through.
    static func beep(sampleRate: Double) -> AVAudioSourceNodeRenderBlock {
        let state = BeepPosition()
        return { _, _, frameCount, bufferList in
            let buffers = UnsafeMutableAudioBufferListPointer(bufferList)
            for frame in 0..<Int(frameCount) {
                let time = Double(state.sample.add(1, ordering: .relaxed).oldValue) / sampleRate
                let position = time.truncatingRemainder(dividingBy: 1)
                let sounding = position < 0.15 || (position >= 0.25 && position < 0.4)
                let wave = sin(2 * Double.pi * 880 * time)
                let value = Float(sounding ? (wave > 0 ? 0.9 : -0.9) : 0)
                for buffer in buffers {
                    buffer.mData?.assumingMemoryBound(to: Float.self)[frame] = value
                }
            }
            return noErr
        }
    }
}

/// The position of the beep, kept across render calls. The audio thread is its only writer; an atomic makes it safe
/// to hand to that thread without a lock, which a render block must not wait on.
private final class BeepPosition: Sendable {

    let sample = Atomic<Int64>(0)
}
