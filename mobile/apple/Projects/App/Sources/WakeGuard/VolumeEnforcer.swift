#if os(iOS)
@preconcurrency import AVFoundation
import MediaPlayer
#endif
import SwiftUI

/// An invisible view that holds the device's volume at its maximum for as long as it is on screen, so the person
/// cannot turn the guard's sound down. iOS lets an app set the volume only through the system volume slider, so the
/// view hosts one out of sight and moves it to the top whenever the volume drops. macOS has nothing to hold.
struct VolumeEnforcer: View {

    // MARK: - Body
    var body: some View {
        #if os(iOS)
        SystemVolumeSlider()
            .frame(width: 1, height: 1)
            .opacity(0.01)
            .allowsHitTesting(false)
            .accessibilityHidden(true)
        #else
        EmptyView()
        #endif
    }
}

#if os(iOS)
/// The system volume slider, kept at its maximum.
private struct SystemVolumeSlider: UIViewRepresentable {

    func makeUIView(context: Context) -> MPVolumeView {
        let view = MPVolumeView(frame: .zero)
        context.coordinator.attach(to: view)
        return view
    }

    func updateUIView(_ uiView: MPVolumeView, context: Context) {}

    func makeCoordinator() -> VolumeHolder {
        VolumeHolder()
    }

    static func dismantleUIView(_ uiView: MPVolumeView, coordinator: VolumeHolder) {
        coordinator.detach()
    }
}

/// Watches the output volume and moves the hosted slider back to the top whenever it drops.
@MainActor
private final class VolumeHolder {

    private weak var view: MPVolumeView?
    private var observation: NSKeyValueObservation?
    private var timer: Timer?

    func attach(to view: MPVolumeView) {
        self.view = view
        observation = AVAudioSession.sharedInstance().observe(\.outputVolume) { [weak self] _, _ in
            Task { @MainActor in self?.raise() }
        }
        // The slider exists only once the view is laid out; a short repeat also covers a volume the observation missed.
        timer = Timer.scheduledTimer(withTimeInterval: 0.5, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.raise() }
        }
    }

    func detach() {
        observation?.invalidate()
        timer?.invalidate()
    }

    func raise() {
        guard AVAudioSession.sharedInstance().outputVolume < 1, let view else { return }
        // The system slider is the only subview of its kind; setting its value through key-value coding moves the
        // device's volume without naming UIKit's slider type.
        for subview in view.subviews where String(describing: type(of: subview)).contains("Slider") {
            subview.setValue(Float(1), forKey: "value")
        }
    }
}
#endif
