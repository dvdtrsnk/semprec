@preconcurrency internal import SharedSDK

// MARK: - Recordings
extension SharedScreenModelFactory {

    public func makeRecordings() -> any RecordingsScreenModel {
        SharedRecordingsScreenModel(sdk.recordings.recordingsViewModel())
    }

    public func makeRecorder(eventId: String?) -> any RecorderScreenModel {
        SharedRecorderScreenModel(sdk.recordings.recorderViewModel(eventId: eventId))
    }

    public func makeTranscript(transcriptId: String) -> any TranscriptScreenModel {
        SharedTranscriptScreenModel(sdk.recordings.transcriptViewModel(transcriptId: transcriptId))
    }

    public func makeMeeting(eventId: String) -> any MeetingScreenModel {
        SharedMeetingScreenModel(sdk.recordings.meetingViewModel(eventId: eventId))
    }
}
