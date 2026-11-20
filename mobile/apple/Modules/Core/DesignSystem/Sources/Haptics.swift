import CoreHaptics
import SwiftUI

/// A short, soft pulse: a little longer than the system's tap, so it feels as strong without its sharp edge.
public enum HapticPulse: Sendable {

    /// An object armed to drop.
    case standard

    var intensity: Float { 0.45 }

    var sharpness: Float { 0.15 }

    /// Seconds; the system's tap lasts about a hundredth of a second.
    var duration: TimeInterval { 0.035 }
}

// MARK: - Haptics
extension View {

    /// Plays `pulse` each time `trigger` changes.
    public func haptic(_ pulse: HapticPulse, trigger: some Equatable) -> some View {
        onChange(of: trigger) { HapticPlayer.shared.play(pulse) }
    }
}

/// Plays pulses on the device's haptic engine; a device without one, such as a Mac, plays nothing.
@MainActor
private final class HapticPlayer {

    static let shared = HapticPlayer()

    private let supported = CHHapticEngine.capabilitiesForHardware().supportsHaptics
    private var engine: CHHapticEngine?

    func play(_ pulse: HapticPulse) {
        guard supported else { return }
        do {
            let engine = try self.engine ?? makeEngine()
            self.engine = engine
            try engine.start()
            let event = CHHapticEvent(
                eventType: .hapticContinuous,
                parameters: [
                    CHHapticEventParameter(parameterID: .hapticIntensity, value: pulse.intensity),
                    CHHapticEventParameter(parameterID: .hapticSharpness, value: pulse.sharpness)
                ],
                relativeTime: 0,
                duration: pulse.duration
            )
            try engine.makePlayer(with: CHHapticPattern(events: [event], parameters: [])).start(atTime: 0)
        } catch {
            // A pulse is only feedback: one the engine refuses is left out, and the engine is made anew next time.
            engine = nil
        }
    }

    private func makeEngine() throws -> CHHapticEngine {
        let engine = try CHHapticEngine()
        engine.isAutoShutdownEnabled = true
        return engine
    }
}
