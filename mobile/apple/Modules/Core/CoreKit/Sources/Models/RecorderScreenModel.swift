import Foundation

/// Where a recording is: nothing happens, the microphone is open (recording or paused), the take is being closed into
/// a file, the file goes to the server, or something failed.
public enum RecorderPhase: Equatable, Sendable {

    case idle
    case recording
    case paused
    case saving
    case uploading
    case failed
}

/// What went wrong.
public enum RecorderProblem: Equatable, Sendable {

    case permissionDenied
    case startFailed
    case captureFailed
    case importFailed
    case uploadFailed
}

/// The recorder. `levels` are the last loudness readings from 0 to 1, newest last.
public struct RecorderState: Equatable, Sendable {

    public var phase: RecorderPhase
    public var elapsedSeconds: Int
    public var levels: [Float]
    public var problem: RecorderProblem?
    public var failure: FailureKind?
    /// True while the screen must not be left: the take is open or its file is still on its way.
    public var busy: Bool

    public init(
        phase: RecorderPhase = .idle,
        elapsedSeconds: Int = 0,
        levels: [Float] = [],
        problem: RecorderProblem? = nil,
        failure: FailureKind? = nil,
        busy: Bool = false
    ) {
        self.phase = phase
        self.elapsedSeconds = elapsedSeconds
        self.levels = levels
        self.problem = problem
        self.failure = failure
        self.busy = busy
    }
}

public enum RecorderAction: Equatable, Sendable {

    case start
    case pause
    case resume
    case stop
    case discard
    case retry
    /// Sends the audio or video file at `path` as a recording.
    case importFile(path: String)
}

public enum RecorderEffect: Equatable, Sendable {

    /// The recording reached the server; the lists of recordings should read again.
    case uploaded
}

public typealias RecorderScreenModel = ScreenModel<RecorderState, RecorderAction, RecorderEffect>

/// Recorder screen model for previews and tests; it never starts the Kotlin runtime.
public typealias ScriptedRecorderScreenModel = ScriptedScreenModel<RecorderState, RecorderAction, RecorderEffect>
