@preconcurrency import AVFoundation
import Combine
import CoreGraphics
import Foundation
import VideoToolbox

/// The back camera read for barcodes and QR codes: publishes each frame as an image for the preview and each code it
/// reads. It needs no UIKit: the preview is SwiftUI drawing the published frames.
@MainActor
final class CodeScanner: ObservableObject {

    // MARK: - Published Properties
    @Published private(set) var frame: CGImage?
    /// The last code read; it repeats while the camera keeps seeing it.
    @Published private(set) var code: String?
    @Published private(set) var cameraState: CameraState = .starting

    // MARK: - Dependencies
    private let session = AVCaptureSession()
    private let output = CameraOutput()
    private let queue = DispatchQueue(label: "cz.semprec.app.codeScanner")

    /// Whether the camera can run.
    enum CameraState: Equatable {

        case starting
        case running
        case denied
        case unavailable
    }

    // MARK: - Methods
    /// Asks for the camera the first time and starts reading.
    func start() async {
        guard await AVCaptureDevice.requestAccess(for: .video) else {
            cameraState = .denied
            return
        }
        guard configure() else {
            cameraState = .unavailable
            return
        }
        output.onFrame = { [weak self] image in Task { @MainActor in self?.frame = image } }
        output.onCode = { [weak self] code in Task { @MainActor in self?.code = code } }
        let session = session
        queue.async { session.startRunning() }
        cameraState = .running
    }

    func stop() {
        let session = session
        queue.async { session.stopRunning() }
    }
}

// MARK: - Private
private extension CodeScanner {

    static let codeTypes: [AVMetadataObject.ObjectType] = [
        .ean8, .ean13, .upce, .code39, .code93, .code128, .itf14, .interleaved2of5, .qr, .dataMatrix, .pdf417, .aztec
    ]

    /// Adds the back camera, the code reader and the frame output once; answers whether the camera is there.
    func configure() -> Bool {
        guard session.inputs.isEmpty else { return true }
        guard
            let camera = AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: .back)
                ?? AVCaptureDevice.default(for: .video),
            let input = try? AVCaptureDeviceInput(device: camera),
            session.canAddInput(input)
        else { return false }
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
            // Portrait frames, as the phone is held while scanning.
            if let connection = video.connection(with: .video), connection.isVideoRotationAngleSupported(90) {
                connection.videoRotationAngle = 90
            }
        }
        session.commitConfiguration()
        return true
    }
}

/// Receives the camera's codes and frames on the scanner's queue and hands them on.
private final class CameraOutput: NSObject, AVCaptureMetadataOutputObjectsDelegate,
    AVCaptureVideoDataOutputSampleBufferDelegate, @unchecked Sendable {

    var onFrame: (@Sendable (CGImage) -> Void)?
    var onCode: (@Sendable (String) -> Void)?

    func metadataOutput(
        _ output: AVCaptureMetadataOutput,
        didOutput metadataObjects: [AVMetadataObject],
        from connection: AVCaptureConnection
    ) {
        for object in metadataObjects {
            if let code = (object as? AVMetadataMachineReadableCodeObject)?.stringValue { onCode?(code) }
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
        if let image { onFrame?(image) }
    }
}
