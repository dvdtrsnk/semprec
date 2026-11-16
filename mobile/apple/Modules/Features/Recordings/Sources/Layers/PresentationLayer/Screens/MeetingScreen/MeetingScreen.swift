import CoreKit
import DesignSystem
import SwiftUI
import UniformTypeIdentifiers

/// The page of an event: when and where it is, the tasks it hosts and the ones its transcripts suggest, a way to its
/// notes, its recordings with the way to record or import one, its people, and its project and company. What the
/// person records here belongs to the event.
struct MeetingScreen: View {

    // MARK: - Dependencies
    @StateObject var viewModel: MeetingViewModel
    @StateObject var recorder: RecorderViewModel

    // MARK: - State
    @State var draft = ""
    @State var importing = false

    // MARK: - Init
    /// Both view models run once per screen, when SwiftUI creates the state objects.
    init(
        viewModel: @autoclosure @escaping () -> MeetingViewModel,
        recorder: @autoclosure @escaping () -> RecorderViewModel
    ) {
        _viewModel = StateObject(wrappedValue: viewModel())
        _recorder = StateObject(wrappedValue: recorder())
    }

    // MARK: - Body
    var body: some View {
        content
            .background(Theme.Colors.groupedBackground)
            .navigationTitle(Text(viewModel.state.title))
            .inlineNavigationTitle()
            .navigationBarBackButtonHidden(recorder.state.busy)
            .toolbar {
                ToolbarItem(placement: .primaryAction) {
                    Button { viewModel.send(.openDetails) } label: { Text("meeting.edit", bundle: .module) }
                        .disabled(viewModel.state.phase != .content)
                        .accessibilityIdentifier(RecordingsIdentifiers.edit)
                }
            }
            .safeAreaInset(edge: .bottom) {
                RecorderPanel(
                    recorder: recorder,
                    context: .event(title: viewModel.state.title),
                    showsRecordButton: false
                )
            }
            .fileImporter(isPresented: $importing, allowedContentTypes: [.audio, .movie]) { result in
                if case .success(let url) = result { recorder.sendImport(of: url) }
            }
            .alert(
                Text("meeting.failed", bundle: .module),
                isPresented: Binding(
                    get: { viewModel.state.writeFailure != nil },
                    set: { _ in viewModel.send(.dismissFailure) }
                )
            ) {
                Button(role: .cancel) {} label: { Text("common.ok", bundle: .module) }
            } message: {
                Text(FailureKind.message(for: viewModel.state.writeFailure?.kind))
            }
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier(RecordingsIdentifiers.meetingScreen)
            .task { await viewModel.observe() }
            .task { await recorder.observe { viewModel.send(.refresh) } }
    }
}

// MARK: - Subviews
extension MeetingScreen {

    var state: MeetingState { viewModel.state }

    @ViewBuilder var content: some View {
        switch state.phase {
        case .loading:
            StatusView(.loading)
        case .error:
            StatusView(
                .failure(message: Text(FailureKind.message(for: state.failure)), retry: { viewModel.send(.retry) })
            )
        case .content:
            List {
                headerSection
                tasksSection
                notesSection
                recordingsSection
                peopleSection
                contextSection
            }
            .groupedListStyle()
            .refreshable { await viewModel.refresh() }
        }
    }

    var headerSection: some View {
        Section {
            VStack(alignment: .leading, spacing: 4) {
                Text(state.title).font(.title.weight(.bold))
                if !state.place.isEmpty {
                    Label { Text(state.place) } icon: { Image(systemName: "mappin.and.ellipse") }
                        .font(.subheadline)
                        .foregroundStyle(Theme.Colors.secondaryText)
                }
                Text(when).font(.subheadline).foregroundStyle(Theme.Colors.secondaryText)
            }
            .padding(.horizontal, Theme.Spacing.medium)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .listRowBackground(Color.clear)
        .listRowInsets(EdgeInsets())
    }

    var when: String {
        let day = RecordingFormatting.eventDay(state.date) ?? ""
        let times = RecordingFormatting.eventTimes(from: state.timeFrom, to: state.timeTo)
            ?? String(localized: "meeting.allDay", bundle: .module)
        return day.isEmpty ? times : "\(day) \u{00B7} \(times)"
    }
}

// MARK: - Preview
#Preview {
    NavigationStack {
        MeetingScreen(
            viewModel: MeetingViewModel(
                model: ScriptedMeetingScreenModel(
                    state: MeetingState(
                        phase: .content,
                        title: "Client meeting",
                        place: "Office",
                        date: "2026-10-16",
                        timeFrom: "10:00",
                        timeTo: "11:30",
                        projectName: "Web for the client",
                        companyName: "Novak Web",
                        people: [MeetingPersonRow(id: "p1", name: "Petr Novak")],
                        tasks: [
                            MeetingTaskRow(id: "t1", title: "Send the offer", status: .open, detail: nil, busy: false),
                            MeetingTaskRow(id: "t2", title: "Call", status: .done, detail: nil, busy: false)
                        ],
                        suggestions: [
                            MeetingSuggestionRow(
                                transcriptId: "tr1",
                                actionItemId: 0,
                                text: "Prepare wireframes",
                                ownerLabel: "Jana",
                                due: "2026-10-30",
                                busy: false
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
