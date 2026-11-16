@preconcurrency internal import SharedSDK

// MARK: - Shared recording values
extension RecordingRow {

    init(_ row: SharedSDK.RecordingRow) {
        self.init(
            id: row.id,
            name: row.name,
            date: row.date,
            durationSeconds: row.durationSeconds.map { Int($0.int32Value) },
            status: row.status.map(RecordingStatus.init),
            pairing: RecordingPairing(row.pairing),
            eventName: row.eventName,
            shortSummary: row.shortSummary,
            processing: row.processing
        )
    }
}

// MARK: - Shared recording status
extension RecordingStatus {

    init(_ status: SharedSDK.RecordingStatus) {
        switch status {
        case .recording: self = .recording
        case .processing: self = .processing
        case .done: self = .done
        case .error: self = .error
        }
    }
}

// MARK: - Shared recording pairing
extension RecordingPairing {

    init(_ pairing: SharedSDK.RecordingPairing) {
        switch pairing {
        case .processing: self = .processing
        case .event: self = .event
        case .awaitingEvent: self = .awaitingEvent
        case .none: self = .unpaired
        }
    }
}
