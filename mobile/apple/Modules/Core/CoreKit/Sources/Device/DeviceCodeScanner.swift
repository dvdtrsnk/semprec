@preconcurrency import AVFoundation
import Combine
import CoreGraphics
import Foundation
import Synchronization
import VideoToolbox

/// Whether the camera can read codes.
public enum CameraState: Equatable, Sendable {

    case starting
    case running
    case denied
    case unavailable
}

/// The camera read for barcodes and QR codes. `run(onCode:)` publishes the frames for a preview drawn in SwiftUI, so
/// that no UIKit or AppKit view is needed, and hands over each code the camera reads, repeated only after
/// `CodeRepeatFilter.interval` while the camera keeps seeing it. It decides nothing about a code: the shared guard
/// says whether it is one of the mission's. The capture queue yields into two streams directly, with no task per
/// frame.
@MainActor
public final class DeviceCodeScanner: ObservableObject {

    // MARK: - Published Properties
    /// The newest frame, while the camera runs.
    @Published public private(set) var frame: CGImage?
    @Published public private(set) var state: CameraState = .starting

    // MARK: - Properties
    private let codes: AsyncStream<String>
    private let frames: AsyncStream<CGImage>
    private let codeContinuation: AsyncStream<String>.Continuation
    private let frameContinuation: AsyncStream<CGImage>.Continuation
    private let session = AVCaptureSession()
    private let queue = DispatchQueue(label: "cz.semprec.app.codeScanner")
    private var isConfigured = false

    // MARK: - Init
    public init() {
        (codes, codeContinuation) = AsyncStream.makeStream(of: String.self, bufferingPolicy: .bufferingNewest(8))
        (frames, frameContinuation) = AsyncStream.makeStream(of: CGImage.self, bufferingPolicy: .bufferingNewest(1))
    }

    deinit {
        codeContinuation.finish()
        frameContinuation.finish()
    }

    // MARK: - Methods
    /// Asks for the camera the first time, runs it and hands over each code it reads, until the surrounding task is
    /// cancelled, which stops the camera. A camera that cannot run is the `state`, and the call returns at once.
    public func run(onCode: @escaping @MainActor @Sendable (String) -> Void) async {
        state = .starting
        guard await AVCaptureDevice.requestAccess(for: .video) else {
            state = .denied
            return
        }
        guard configureOnce() else {
            state = .unavailable
            return
        }
        let session = session
        queue.async { session.startRunning() }
        state = .running
        async let publishing: Void = publishFrames()
        async let delivering: Void = deliverCodes(to: onCode)
        _ = await (publishing, delivering)
        queue.async { session.stopRunning() }
    }
}

// MARK: - Private
private extension DeviceCodeScanner {

    func publishFrames() async {
        for await image in frames { frame = image }
    }

    func deliverCodes(to onCode: @MainActor @Sendable (String) -> Void) async {
        for await code in codes { onCode(code) }
    }

    static let codeTypes: [AVMetadataObject.ObjectType] = [
        .ean8, .ean13, .upce, .code39, .code93, .code128, .itf14, .interleaved2of5, .qr, .dataMatrix, .pdf417, .aztec
    ]

    /// Adds the camera, the code reader and the frame output once; answers whether the camera is there.
    func configureOnce() -> Bool {
        guard !isConfigured else { return true }
        guard
            let camera = AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: .back)
                ?? AVCaptureDevice.default(for: .video),
            let input = try? AVCaptureDeviceInput(device: camera),
            session.canAddInput(input)
        else { return false }
        let output = CameraOutput(codes: codeContinuation, frames: frameContinuation)
        session.beginConfiguration()
        session.addInput(input)
        let metadata = AVCaptureMetadataOutput()
        if session.canAddOutput(metadata) {
            session.addOutput(metadata)
            metadata.setMetadataObjectsDelegate(output, queue: queue)
            metadata.metadataObjectTypes = Self.codeTypes.filter(metadata.availableMetadataObjectTypes.contains)
        }
        let video = AVCaptureVideoDataOutput()
        video.alwaysDiscardsLateVideoFrames = true
        if session.canAddOutput(video) {
            session.addOutput(video)
            video.setSampleBufferDelegate(output, queue: queue)
            #if os(iOS)
            // Portrait frames, as the phone is held while scanning.
            if let connection = video.connection(with: .video), connection.isVideoRotationAngleSupported(90) {
                connection.videoRotationAngle = 90
            }
            #endif
        }
        session.commitConfiguration()
        isConfigured = true
        return true
    }
}

/// Receives the camera's codes and frames on the scanner's queue and yields them into the scanner's streams. Its
/// stored values are constants that are `Sendable` themselves, and the one mutable value, the filter that stops a code
/// from repeating, is behind a `Mutex`, so the compiler checks its conformance.
private final class CameraOutput: NSObject, AVCaptureMetadataOutputObjectsDelegate,
    AVCaptureVideoDataOutputSampleBufferDelegate, Sendable {

    private let codes: AsyncStream<String>.Continuation
    private let frames: AsyncStream<CGImage>.Continuation
    private let filter = Mutex(CodeRepeatFilter())

    init(codes: AsyncStream<String>.Continuation, frames: AsyncStream<CGImage>.Continuation) {
        self.codes = codes
        self.frames = frames
    }

    func metadataOutput(
        _ output: AVCaptureMetadataOutput,
        didOutput metadataObjects: [AVMetadataObject],
        from connection: AVCaptureConnection
    ) {
        let now = Date()
        for object in metadataObjects {
            guard let code = (object as? AVMetadataMachineReadableCodeObject)?.stringValue else { continue }
            if filter.withLock({ $0.accepts(code, at: now) }) { codes.yield(code) }
        }
    }

    func captureOutput(
        _ output: AVCaptureOutput,
        didOutput sampleBuffer: CMSampleBuffer,
        from connection: AVCaptureConnection
    ) {
        guard let buffer = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }
        var image: CGImage?
        VTCreateCGImageFromCVPixelBuffer(buffer, options: nil, imageOut: &image)
        if let image { frames.yield(image) }
    }
}
