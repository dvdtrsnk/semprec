#if os(iOS)
@preconcurrency import AVFoundation
import MediaPlayer
import SwiftUI

/// The device's volume through `MPVolumeView`, the only way iOS lets an app set it. The view hides a `UISlider` that
/// moves the system volume when its value is set; that subview is undocumented UIKit internals, so a future iOS can
/// remove it and the hold then silently does nothing, which leaves the alarm ringing at the person's own volume. This
/// is the only file that imports MediaPlayer and the one place that touches the slider; it cannot be tested without a
/// device, and `VolumeHold` around it is tested with a scripted `SystemVolume`.
@MainActor
final class MediaPlayerVolume: ObservableObject {

    // MARK: - Properties
    /// The view the system volume control lives in; `MediaPlayerVolumeHost` puts it in the window out of sight.
    let view = MPVolumeView(frame: .zero)

    // MARK: - Init
    init() {
        // `outputVolume` is only reported while the app's audio session is active, in the same playback category as
        // the guard's beep, so the hold does not depend on the beep having started first.
        AudioSessionConfiguration.activate(recording: false)
    }
}

// MARK: - Protocol conformance
extension MediaPlayerVolume: SystemVolume {

    var level: Float {
        AVAudioSession.sharedInstance().outputVolume
    }

    func raiseToMaximum() -> Bool {
        // The control is a slider among the volume view's subviews, which exist only once the view is laid out.
        guard let slider = view.subviews.lazy.compactMap({ $0 as? UISlider }).first else { return false }
        slider.value = 1
        return true
    }

    func changes() -> AsyncStream<Void> {
        AsyncStream(bufferingPolicy: .bufferingNewest(1)) { continuation in
            let observation = AVAudioSession.sharedInstance().observe(\.outputVolume) { _, _ in
                continuation.yield()
            }
            continuation.onTermination = { _ in observation.invalidate() }
        }
    }
}

/// Hosts the volume view out of sight and holds the volume while `isHeld`.
struct MediaPlayerVolumeHost: View {

    // MARK: - Dependencies
    let isHeld: Bool

    // MARK: - State
    @StateObject private var volume = MediaPlayerVolume()

    // MARK: - Body
    var body: some View {
        VolumeViewHost(view: volume.view)
            .frame(width: 1, height: 1)
            .opacity(0.01)
            .allowsHitTesting(false)
            .accessibilityHidden(true)
            .task(id: isHeld) {
                guard isHeld else { return }
                await VolumeHold(volume: volume).run()
            }
    }
}

/// Puts the one volume view into the SwiftUI hierarchy.
private struct VolumeViewHost: UIViewRepresentable {

    let view: MPVolumeView

    func makeUIView(context: Context) -> MPVolumeView {
        view
    }

    func updateUIView(_ uiView: MPVolumeView, context: Context) {}
}
#endif
