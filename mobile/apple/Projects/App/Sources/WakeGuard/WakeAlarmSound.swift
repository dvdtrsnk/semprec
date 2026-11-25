@preconcurrency import AVFoundation
import Foundation
import Synchronization

/// The guard's own alarm sound while the app is open: a loud repeating beep the app plays itself, on top of the
/// system's alarms. On iOS it plays in the playback category, which the silent switch does not mute, and keeps
/// playing when the person leaves the app, because the app may play audio in the background.
@MainActor
final class WakeAlarmSound {

    // MARK: - Dependencies
    private let engine = AVAudioEngine()
    private var isPlaying = false

    // MARK: - Methods
    /// Starts the beep; a failure to start leaves the system's watch alarms as the only sound.
    func start() throws {
        guard !isPlaying else { return }
        #if os(iOS)
        let session = AVAudioSession.sharedInstance()
        try session.setCategory(.playback, mode: .default, options: [])
        try session.setActive(true)
        #endif
        let format = engine.outputNode.inputFormat(forBus: 0)
        let source = AVAudioSourceNode(renderBlock: Self.beep(sampleRate: format.sampleRate))
        engine.attach(source)
        engine.connect(source, to: engine.mainMixerNode, format: AVAudioFormat(
            standardFormatWithSampleRate: format.sampleRate,
            channels: 1
        ))
        engine.mainMixerNode.outputVolume = 1
        try engine.start()
        isPlaying = true
    }

    func stop() {
        guard isPlaying else { return }
        engine.stop()
        isPlaying = false
        #if os(iOS)
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        #endif
    }
}

// MARK: - Private
private extension WakeAlarmSound {

    /// Two short 880 Hz beeps, then a pause, every second, as a square-ish wave that cuts through.
    static func beep(sampleRate: Double) -> AVAudioSourceNodeRenderBlock {
        let state = BeepState()
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
private final class BeepState: Sendable {

    let sample = Atomic<Int64>(0)
}
