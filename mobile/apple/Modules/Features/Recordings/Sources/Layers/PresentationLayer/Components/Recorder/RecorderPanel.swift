import CoreKit
import DesignSystem
import SwiftUI

/// What a recording made in a recorder is for: it belongs to no event yet, or to the event of this title.
enum RecorderContext: Equatable {

    case noEvent
    case event(title: String)
}

/// The recorder as the board draws it: a glass card with the clock and the waveform while a take runs, a record button
/// while idle (when `showsRecordButton`), and the way out of a failure. The model decides every step.
struct RecorderPanel: View {

    // MARK: - Dependencies
    @ObservedObject var recorder: RecorderViewModel
    let context: RecorderContext
    let showsRecordButton: Bool

    // MARK: - Body
    var body: some View {
        content
            .frame(maxWidth: .infinity)
            .padding(.horizontal, Theme.Spacing.small)
            .padding(.bottom, Theme.Spacing.small)
            .animation(.default, value: recorder.state.phase)
    }
}

// MARK: - Subviews
private extension RecorderPanel {

    var state: RecorderState { recorder.state }

    @ViewBuilder var content: some View {
        switch state.phase {
        case .idle:
            if showsRecordButton { recordButton }
        case .recording, .paused:
            takeCard
        case .saving, .uploading:
            progressCard
        case .failed:
            failureCard
        }
    }

    var recordButton: some View {
        Button { recorder.send(.start) } label: {
            Circle()
                .fill(Theme.Colors.destructive)
                .frame(width: 56, height: 56)
                .padding(Theme.Spacing.small)
        }
        .buttonStyle(.plain)
        .glassEffect(.regular.interactive(), in: .circle)
        .accessibilityLabel(Text("recorder.record", bundle: .module))
        .accessibilityIdentifier(RecordingsIdentifiers.record)
    }

    var takeCard: some View {
        VStack(spacing: Theme.Spacing.medium) {
            HStack(spacing: Theme.Spacing.small) {
                Circle()
                    .fill(Theme.Colors.destructive)
                    .frame(width: 10, height: 10)
                    .opacity(state.phase == .recording ? 1 : 0.35)
                VStack(alignment: .leading, spacing: 2) {
                    title.font(.subheadline.weight(.semibold))
                    subtitle.font(.caption).foregroundStyle(Theme.Colors.secondaryText)
                }
                Spacer()
                Text(RecordingFormatting.clock(state.elapsedSeconds))
                    .font(.system(size: 34, weight: .light).monospacedDigit())
                    .accessibilityIdentifier(RecordingsIdentifiers.clock)
            }
            Waveform(levels: state.levels, paused: state.phase == .paused)
                .frame(height: 44)
                .accessibilityHidden(true)
            controls
        }
        .padding(Theme.Spacing.medium)
        .glassEffect(.regular, in: .rect(cornerRadius: 34))
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier(RecordingsIdentifiers.panel)
    }

    var title: Text {
        if state.phase == .paused { return Text("recorder.title.paused", bundle: .module) }
        switch context {
        case .noEvent: return Text("recorder.title.new", bundle: .module)
        case .event(let title): return Text(verbatim: title)
        }
    }

    @ViewBuilder var subtitle: some View {
        switch context {
        case .noEvent: Text("recorder.subtitle.noEvent", bundle: .module)
        case .event: Text(state.phase == .paused ? "recorder.title.paused" : "recorder.subtitle.event", bundle: .module)
        }
    }

    var controls: some View {
        HStack {
            Button { recorder.send(.discard) } label: { Text("recorder.discard", bundle: .module) }
                .buttonStyle(.bordered)
                .accessibilityIdentifier(RecordingsIdentifiers.discard)
            Spacer()
            Button { recorder.send(.stop) } label: {
                RoundedRectangle(cornerRadius: 6)
                    .fill(Theme.Colors.destructive)
                    .frame(width: 26, height: 26)
                    .padding(18)
            }
            .buttonStyle(.plain)
            .glassEffect(.regular.interactive(), in: .circle)
            .accessibilityLabel(Text("recorder.stop", bundle: .module))
            .accessibilityIdentifier(RecordingsIdentifiers.stop)
            Spacer()
            Button { recorder.send(state.phase == .paused ? .resume : .pause) } label: {
                Text(state.phase == .paused ? "recorder.resume" : "recorder.pause", bundle: .module)
            }
            .buttonStyle(.bordered)
            .accessibilityIdentifier(RecordingsIdentifiers.pause)
        }
    }

    var progressCard: some View {
        HStack(spacing: Theme.Spacing.small) {
            ProgressView()
            Text(state.phase == .saving ? "recorder.saving" : "recorder.uploading", bundle: .module)
                .font(.subheadline)
        }
        .padding(Theme.Spacing.medium)
        .frame(maxWidth: .infinity)
        .glassEffect(.regular, in: .rect(cornerRadius: 34))
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier(RecordingsIdentifiers.panel)
    }

    var failureCard: some View {
        VStack(spacing: Theme.Spacing.small) {
            Label {
                Text(problemText)
            } icon: {
                Image(systemName: "exclamationmark.triangle").foregroundStyle(Theme.Colors.destructive)
            }
            .font(.subheadline)
            HStack {
                Button { recorder.send(.discard) } label: { Text("recorder.discard", bundle: .module) }
                    .buttonStyle(.bordered)
                    .accessibilityIdentifier(RecordingsIdentifiers.discard)
                Button { recorder.send(.retry) } label: { Text("recorder.retry", bundle: .module) }
                    .buttonStyle(.borderedProminent)
                    .accessibilityIdentifier(RecordingsIdentifiers.retry)
            }
        }
        .padding(Theme.Spacing.medium)
        .frame(maxWidth: .infinity)
        .glassEffect(.regular, in: .rect(cornerRadius: 34))
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier(RecordingsIdentifiers.panel)
    }

    var problemText: String {
        switch state.problem {
        case .permissionDenied: String(localized: "recorder.problem.permissionDenied", bundle: .module)
        case .startFailed: String(localized: "recorder.problem.startFailed", bundle: .module)
        case .captureFailed: String(localized: "recorder.problem.captureFailed", bundle: .module)
        case .importFailed: String(localized: "recorder.problem.importFailed", bundle: .module)
        case .uploadFailed: FailureKind.message(for: state.failure)
        case nil: FailureKind.message(for: nil)
        }
    }
}

// MARK: - Waveform
/// The last loudness readings as bars, newest on the right; a paused take shows them flat.
private struct Waveform: View {

    let levels: [Float]
    let paused: Bool

    private static let count = 40

    var body: some View {
        GeometryReader { proxy in
            HStack(alignment: .center, spacing: 3) {
                ForEach(0..<Self.count, id: \.self) { index in
                    Capsule()
                        .fill(Theme.Colors.destructive.opacity(paused ? 0.35 : 1))
                        .frame(height: max(4, proxy.size.height * height(at: index)))
                }
            }
            .frame(maxHeight: .infinity)
        }
    }

    private func height(at index: Int) -> CGFloat {
        let offset = Self.count - levels.count
        guard !paused, index >= offset else { return 0.1 }
        return CGFloat(max(levels[index - offset], 0.1))
    }
}
