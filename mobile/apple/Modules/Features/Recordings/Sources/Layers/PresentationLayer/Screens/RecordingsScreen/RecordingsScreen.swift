import CoreKit
import DesignSystem
import SwiftUI
import UniformTypeIdentifiers

/// The recordings: the list of what was recorded, newest first, the record button that starts a recording without an
/// event, and an import of a file. Semp pairs a recording without an event with the meeting that was running.
struct RecordingsScreen: View {

    // MARK: - Dependencies
    @StateObject private var viewModel: RecordingsViewModel
    @StateObject private var recorder: RecorderViewModel

    // MARK: - State
    @State private var importing = false

    // MARK: - Init
    /// Both view models run once per screen, when SwiftUI creates the state objects.
    init(
        viewModel: @autoclosure @escaping () -> RecordingsViewModel,
        recorder: @autoclosure @escaping () -> RecorderViewModel
    ) {
        _viewModel = StateObject(wrappedValue: viewModel())
        _recorder = StateObject(wrappedValue: recorder())
    }

    // MARK: - Body
    var body: some View {
        content
            .background(Theme.Colors.groupedBackground)
            .navigationTitle(Text("recordings.title", bundle: .module))
            .navigationBarBackButtonHidden(recorder.state.busy)
            .toolbar {
                PlainToolbarItem(placement: .primaryAction) {
                    Button { importing = true } label: { Image(systemName: "square.and.arrow.up") }
                        .disabled(recorder.state.phase != .idle)
                        .accessibilityLabel(Text("recordings.import", bundle: .module))
                        .accessibilityIdentifier(RecordingsIdentifiers.importButton)
                }
            }
            .safeAreaInset(edge: .bottom) {
                RecorderPanel(recorder: recorder, context: .noEvent, showsRecordButton: true)
            }
            .fileImporter(isPresented: $importing, allowedContentTypes: [.audio, .movie]) { result in
                if case .success(let url) = result { recorder.sendImport(of: url) }
            }
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier(RecordingsIdentifiers.recordingsScreen)
            .task { await viewModel.observe() }
            .task { await recorder.observe { viewModel.send(.refresh) } }
    }
}

// MARK: - Subviews
private extension RecordingsScreen {

    @ViewBuilder var content: some View {
        switch viewModel.state.phase {
        case .loading:
            StatusView(.loading)
        case .error:
            StatusView(
                .failure(
                    message: Text(FailureKind.message(for: viewModel.state.failure)),
                    retry: { viewModel.send(.retry) }
                )
            )
        case .content:
            if viewModel.state.recordings.isEmpty {
                StatusView(.empty(message: Text("recordings.empty", bundle: .module), systemImage: "waveform"))
            } else {
                list
            }
        }
    }

    var list: some View {
        List {
            Section {
                ForEach(viewModel.state.recordings) { row in
                    Button { viewModel.send(.open(recordingId: row.id)) } label: { RecordingRowView(row: row) }
                        .listRowButton()
                        .accessibilityIdentifier(RecordingsIdentifiers.recordingRowPrefix + row.id)
                }
            } footer: {
                Text("recordings.footer", bundle: .module)
            }
        }
        .groupedListStyle()
        .refreshable { await viewModel.refresh() }
    }
}

// MARK: - Preview
#Preview {
    NavigationStack {
        RecordingsScreen(
            viewModel: RecordingsViewModel(
                model: ScriptedRecordingsScreenModel(
                    state: RecordingsState(
                        phase: .content,
                        recordings: [
                            RecordingRow(
                                id: "r1",
                                name: "Client meeting",
                                date: "2026-10-16T10:02:00+02:00",
                                durationSeconds: 4_867,
                                status: .done,
                                pairing: .event,
                                eventName: "Client meeting",
                                shortSummary: nil,
                                processing: false
                            ),
                            RecordingRow(
                                id: "r2",
                                name: "Recording 14. 10. 13:52",
                                date: "2026-10-14T13:52:00+02:00",
                                durationSeconds: 2_830,
                                status: .processing,
                                pairing: .processing,
                                eventName: nil,
                                shortSummary: nil,
                                processing: true
                            )
                        ]
                    )
                ),
                router: PreviewRecordingsRouter()
            ),
            recorder: RecorderViewModel(model: ScriptedRecorderScreenModel(state: RecorderState()))
        )
    }
}
