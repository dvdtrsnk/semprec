import CoreKit
import DesignSystem
import SwiftUI

/// The transcript of a recording: the summary Semp wrote with its decisions and action items, the words by speaker with
/// a search, and a player that follows them. A voice that is nobody yet can be given to a participant of the event.
struct TranscriptScreen: View {

    // MARK: - Dependencies
    @StateObject var viewModel: TranscriptViewModel

    // MARK: - State
    @State var scrubbing: Double?

    // MARK: - Init
    /// `viewModel` runs once per screen, when SwiftUI creates the state object.
    init(viewModel: @autoclosure @escaping () -> TranscriptViewModel) {
        _viewModel = StateObject(wrappedValue: viewModel())
    }

    // MARK: - Body
    var body: some View {
        content
            .background(Theme.Colors.groupedBackground)
            .navigationTitle(Text(viewModel.state.title))
            .inlineNavigationTitle()
            .toolbar {
                ToolbarItem(placement: .principal) { tabPicker }
            }
            .safeAreaInset(edge: .bottom) { playerBar }
            .confirmationDialog(
                Text("transcript.speakerMenu.title", bundle: .module),
                isPresented: speakerMenuShown,
                titleVisibility: .visible
            ) { speakerMenu }
            .alert(
                Text("transcript.failed", bundle: .module),
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
            .accessibilityIdentifier(RecordingsIdentifiers.transcriptScreen)
            .task { await viewModel.observe() }
    }
}

// MARK: - Subviews
extension TranscriptScreen {

    var state: TranscriptState { viewModel.state }

    @ViewBuilder var content: some View {
        switch state.phase {
        case .loading:
            StatusView(.loading)
        case .error:
            StatusView(
                .failure(message: Text(FailureKind.message(for: state.failure)), retry: { viewModel.send(.retry) })
            )
        case .content:
            if state.status == .done || !state.segments.isEmpty {
                transcriptList
            } else {
                unfinished
            }
        }
    }

    var tabPicker: some View {
        Picker(
            selection: Binding(get: { state.tab }, set: { viewModel.send(.selectTab($0)) }),
            content: {
                Text("transcript.tab.summary", bundle: .module).tag(TranscriptTab.summary)
                Text("transcript.tab.transcript", bundle: .module).tag(TranscriptTab.transcript)
            },
            label: { Text("transcript.tabs", bundle: .module) }
        )
        .pickerStyle(.segmented)
        .frame(maxWidth: 260)
        .accessibilityIdentifier(RecordingsIdentifiers.tabs)
    }

    /// A transcript the server is still making, or could not make.
    var unfinished: some View {
        ScrollView {
            VStack(spacing: Theme.Spacing.medium) {
                if state.status == .error {
                    Label { Text("transcript.failedToProcess", bundle: .module) } icon: {
                        Image(systemName: "exclamationmark.triangle").foregroundStyle(Theme.Colors.destructive)
                    }
                } else {
                    ProgressView()
                    Text("transcript.processing", bundle: .module).foregroundStyle(Theme.Colors.secondaryText)
                }
            }
            .frame(maxWidth: .infinity)
            .padding(Theme.Spacing.large)
        }
        .refreshable { await viewModel.refresh() }
    }

    var transcriptList: some View {
        List {
            Section { header }
                .listRowBackground(Color.clear)
                .listRowInsets(EdgeInsets())
            switch state.tab {
            case .summary: summarySections
            case .transcript: transcriptSections
            }
        }
        .groupedListStyle()
        .refreshable { await viewModel.refresh() }
    }

    var header: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(state.title).font(.title.weight(.bold))
            Text(meta).font(.subheadline).foregroundStyle(Theme.Colors.secondaryText)
        }
        .padding(.horizontal, Theme.Spacing.medium)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    var meta: String {
        [
            RecordingFormatting.day(state.date),
            state.durationSeconds.map(RecordingFormatting.clock),
            RecordingFormatting.language(state.language)
        ]
        .compactMap { $0 }
        .joined(separator: " \u{00B7} ")
    }

    var speakerMenuShown: Binding<Bool> {
        Binding(
            get: { state.speakerMenu != nil },
            set: { if !$0 && state.speakerMenu != nil { viewModel.send(.closeSpeakerMenu) } }
        )
    }

    @ViewBuilder var speakerMenu: some View {
        ForEach(state.candidates) { candidate in
            Button { viewModel.send(.assignSpeaker(personId: candidate.personId)) } label: {
                Text(candidate.name)
            }
        }
        if let open = state.speakerMenu, state.segments.first(where: { $0.speaker == open })?.mapped == true {
            Button(role: .destructive) { viewModel.send(.assignSpeaker(personId: nil)) } label: {
                Text("transcript.speakerMenu.clear", bundle: .module)
            }
        }
    }
}
