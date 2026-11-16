import AVFoundation
import Foundation
@preconcurrency internal import SharedSDK

/// The shared layer's `AudioPlayer` on the device speaker: an `AVPlayer` that streams the recording from the server
/// with the bearer token. It decides nothing; what plays and at which speed is the Kotlin `TranscriptViewModel`, which
/// this reports back to. Every call comes on the main thread.
@MainActor
final class DeviceAudioPlayer: NSObject {

    // MARK: - Properties
    private var player: AVPlayer?
    private var listener: (any SharedSDK.PlayerListener)?
    private var timeObserver: Any?
    private var statusObservation: NSKeyValueObservation?
    private var endObserver: (any NSObjectProtocol)?
    private var rate: Float = 1
}

// MARK: - Protocol conformance
extension DeviceAudioPlayer: @preconcurrency SharedSDK.AudioPlayer {

    func prepare(source: SharedSDK.PlaybackSource, listener: any SharedSDK.PlayerListener) {
        dispose()
        guard let url = URL(string: source.url) else {
            listener.onFailed()
            return
        }
        self.listener = listener
        AudioSessionConfiguration.activate(recording: false)
        let headers = ["Authorization": source.authorization]
        let asset = AVURLAsset(url: url, options: ["AVURLAssetHTTPHeaderFieldsKey": headers])
        let item = AVPlayerItem(asset: asset)
        let created = AVPlayer(playerItem: item)
        player = created
        observe(item, on: created)
    }

    func play() {
        guard let player else { return }
        player.defaultRate = rate
        player.play()
    }

    func pause() {
        player?.pause()
    }

    func seekTo(seconds: Double) {
        player?.seek(to: CMTime(seconds: seconds, preferredTimescale: Self.timescale))
    }

    func setRate(rate: Float) {
        self.rate = rate
        guard let player else { return }
        player.defaultRate = rate
        if player.timeControlStatus != .paused { player.rate = rate }
    }

    func dispose() {
        if let timeObserver { player?.removeTimeObserver(timeObserver) }
        if let endObserver { NotificationCenter.default.removeObserver(endObserver) }
        statusObservation = nil
        timeObserver = nil
        endObserver = nil
        player?.pause()
        player = nil
        listener = nil
    }
}

// MARK: - Private
private extension DeviceAudioPlayer {

    static let timescale: CMTimeScale = 600
    static let tick = CMTime(seconds: 0.25, preferredTimescale: timescale)

    func observe(_ item: AVPlayerItem, on player: AVPlayer) {
        timeObserver = player.addPeriodicTimeObserver(forInterval: Self.tick, queue: .main) { [weak self] time in
            MainActor.assumeIsolated { self?.listener?.onPosition(seconds: max(time.seconds, 0)) }
        }
        endObserver = NotificationCenter.default.addObserver(
            forName: .AVPlayerItemDidPlayToEndTime,
            object: item,
            queue: .main
        ) { [weak self] _ in
            MainActor.assumeIsolated { self?.listener?.onEnded() }
        }
        statusObservation = item.observe(\.status, options: [.new]) { [weak self] item, _ in
            let status = item.status
            let duration = item.duration.seconds
            Task { @MainActor in self?.report(status, duration: duration) }
        }
    }

    func report(_ status: AVPlayerItem.Status, duration: Double) {
        switch status {
        case .readyToPlay:
            if duration.isFinite { listener?.onDuration(seconds: duration) }
        case .failed:
            listener?.onFailed()
        case .unknown:
            break
        @unknown default:
            break
        }
    }
}
