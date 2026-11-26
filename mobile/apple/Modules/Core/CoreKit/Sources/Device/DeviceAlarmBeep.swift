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

    /// The render block of the beep, which reads its position from an atomic the audio thread alone advances.
    static func beep(sampleRate: Double) -> AVAudioSourceNodeRenderBlock {
        let state = BeepPosition()
        return { _, _, frameCount, bufferList in
            let buffers = UnsafeMutableAudioBufferListPointer(bufferList)
            for frame in 0..<Int(frameCount) {
                let time = Double(state.sample.add(1, ordering: .relaxed).oldValue) / sampleRate
                let value = BeepTone.value(at: time)
                for buffer in buffers {
                    buffer.mData?.assumingMemoryBound(to: Float.self)[frame] = value
                }
            }
            return noErr
        }
    }
}

/// The beep as a function of time: two short 880 Hz bursts, then a pause, every second, as a square wave that cuts
/// through.
enum BeepTone {

    static let frequency = 880.0
    static let amplitude: Float = 0.9

    /// The sample at `time` seconds from the start: silent in the pauses, `amplitude` or its negative while sounding.
    static func value(at time: Double) -> Float {
        let position = time.truncatingRemainder(dividingBy: 1)
        let sounding = position < 0.15 || (position >= 0.25 && position < 0.4)
        guard sounding else { return 0 }
        return sin(2 * Double.pi * frequency * time) > 0 ? amplitude : -amplitude
    }
}

/// The position of the beep, kept across render calls. The audio thread is its only writer; an atomic makes it safe
/// to hand to that thread without a lock, which a render block must not wait on.
private final class BeepPosition: Sendable {

    let sample = Atomic<Int64>(0)
}
