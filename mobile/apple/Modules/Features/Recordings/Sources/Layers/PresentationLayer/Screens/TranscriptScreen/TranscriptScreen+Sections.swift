import CoreKit
import DesignSystem
import SwiftUI

// MARK: - Summary
extension TranscriptScreen {

    @ViewBuilder var summarySections: some View {
        contextSection
        if state.summary != nil || !state.decisions.isEmpty { summarySection }
        if !state.actionItems.isEmpty { actionItemsSection }
    }

    var contextSection: some View {
        Section {
            if let eventId = state.eventId, let name = state.eventName ?? Optional(eventId) {
                Button { viewModel.send(.openEvent) } label: {
                    LabeledContent {
                        Text(name).foregroundStyle(Theme.Colors.secondaryText)
                    } label: {
                        Text("transcript.context.event", bundle: .module)
                    }
                }
                .listRowButton()
                .accessibilityIdentifier(RecordingsIdentifiers.eventRow)
            }
            contextRow("transcript.context.project", values: state.project.map { [$0] } ?? [])
            contextRow("transcript.context.company", values: state.company.map { [$0] } ?? [])
            contextRow("transcript.context.people", values: state.people)
        } footer: {
            if state.eventId != nil { Text("transcript.context.note", bundle: .module) }
        }
    }

    func contextRow(_ title: LocalizedStringKey, values: [TranscriptContextItem]) -> some View {
        LabeledContent {
            HStack(spacing: 4) {
                if values.contains(where: \.inherited) {
                    Image(systemName: "link").foregroundStyle(Theme.Colors.accent)
                }
                Text(contextText(values)).foregroundStyle(Theme.Colors.secondaryText)
            }
        } label: {
            Text(title, bundle: .module)
        }
    }

    func contextText(_ values: [TranscriptContextItem]) -> String {
        if values.isEmpty { return String(localized: "transcript.context.none", bundle: .module) }
        return values.map(\.name).joined(separator: ", ")
    }

    var summarySection: some View {
        Section {
            if let summary = state.summary { Text(summary) }
            ForEach(state.decisions, id: \.self) { decision in
                Label {
                    Text(decision)
                } icon: {
                    Image(systemName: "checkmark.seal").foregroundStyle(Theme.Colors.accent)
                }
            }
        } header: {
            Text("transcript.summary", bundle: .module)
        }
    }

    var actionItemsSection: some View {
        Section {
            ForEach(state.actionItems) { item in
                actionRow(item)
            }
        } header: {
            Text("transcript.actions", bundle: .module)
        } footer: {
            Text("transcript.actions.note", bundle: .module)
        }
    }

    func actionRow(_ item: TranscriptActionRow) -> some View {
        HStack(spacing: Theme.Spacing.small) {
            VStack(alignment: .leading, spacing: 2) {
                Text(item.text)
                if let meta = actionMeta(item) {
                    Text(meta).font(.footnote).foregroundStyle(Theme.Colors.secondaryText)
                }
            }
            Spacer()
            actionButton(item)
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier(RecordingsIdentifiers.actionPrefix + String(item.id))
    }

    func actionMeta(_ item: TranscriptActionRow) -> String? {
        let parts = [item.ownerLabel, RecordingFormatting.due(item.due)].compactMap { $0 }
        return parts.isEmpty ? nil : parts.joined(separator: " \u{00B7} ")
    }

    @ViewBuilder
    func actionButton(_ item: TranscriptActionRow) -> some View {
        let done = item.state == .added || item.state == .noted
        Button {
            if done {
                viewModel.send(.undo(itemId: item.id))
            } else if item.isMine {
                viewModel.send(.addTask(itemId: item.id))
            } else {
                viewModel.send(.follow(itemId: item.id))
            }
        } label: {
            Text(actionLabel(item, done: done))
        }
        .buttonStyle(.bordered)
        .tint(done ? .green : Theme.Colors.accent)
        .disabled(item.busy || item.state == .dismissed)
    }

    func actionLabel(_ item: TranscriptActionRow, done: Bool) -> LocalizedStringKey {
        switch item.state {
        case .added: "transcript.action.added"
        case .noted: "transcript.action.noted"
        case .open, .dismissed: item.isMine ? "transcript.action.addTask" : "transcript.action.follow"
        }
    }
}

// MARK: - Transcript
extension TranscriptScreen {

    @ViewBuilder var transcriptSections: some View {
        Section {
            HStack {
                Image(systemName: "magnifyingglass").foregroundStyle(Theme.Colors.secondaryText)
                TextField(
                    text: Binding(get: { state.query }, set: { viewModel.send(.search($0)) })
                ) { Text("transcript.search", bundle: .module) }
                .accessibilityIdentifier(RecordingsIdentifiers.search)
                if !state.query.isEmpty { Text(String(state.matchCount)).foregroundStyle(Theme.Colors.secondaryText) }
            }
        }
        Section {
            if state.segments.isEmpty {
                Text("transcript.noHits", bundle: .module).foregroundStyle(Theme.Colors.secondaryText)
            }
            ForEach(state.segments) { segment in
                segmentRow(segment)
            }
        }
    }

    func segmentRow(_ segment: TranscriptSegmentRow) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Button { viewModel.send(.openSpeakerMenu(speaker: segment.speaker)) } label: {
                    HStack(spacing: 6) {
                        Circle().fill(color(of: segment)).frame(width: 8, height: 8)
                        Text(segment.label).font(.subheadline.weight(.semibold))
                        if !segment.mapped {
                            Text("transcript.assign", bundle: .module)
                                .font(.caption)
                                .foregroundStyle(Theme.Colors.accent)
                        }
                    }
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier(RecordingsIdentifiers.speakerPrefix + String(segment.index))
                Spacer()
                Button { viewModel.send(.seek(seconds: segment.startsAt)) } label: {
                    Text(RecordingFormatting.clock(Int(segment.startsAt))).font(.caption.monospacedDigit())
                }
                .buttonStyle(.plain)
                .foregroundStyle(Theme.Colors.secondaryText)
            }
            Text(segment.text)
        }
        .padding(.vertical, 2)
        .listRowBackground(segment.active ? Theme.Colors.accent.opacity(0.12) : nil)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier(RecordingsIdentifiers.segmentPrefix + String(segment.index))
    }

    func color(of segment: TranscriptSegmentRow) -> Color {
        let palette: [Color] = [.indigo, .teal, .pink, .orange, .green]
        guard segment.mapped else { return .gray }
        return palette[segment.speaker.unicodeScalars.reduce(0) { $0 + Int($1.value) } % palette.count]
    }
}

// MARK: - Player
extension TranscriptScreen {

    @ViewBuilder var playerBar: some View {
        let player = state.player
        if player.failed {
            Text("transcript.player.failed", bundle: .module)
                .font(.footnote)
                .foregroundStyle(Theme.Colors.secondaryText)
                .padding(Theme.Spacing.small)
                .frame(maxWidth: .infinity)
                .glassEffect(.regular, in: .capsule)
                .padding(.horizontal, Theme.Spacing.small)
        } else if player.available {
            HStack(spacing: Theme.Spacing.small) {
                Button { viewModel.send(.togglePlay) } label: {
                    Image(systemName: player.playing ? "pause.fill" : "play.fill").frame(width: 28, height: 28)
                }
                .accessibilityLabel(Text(player.playing ? "transcript.pause" : "transcript.play", bundle: .module))
                .accessibilityIdentifier(RecordingsIdentifiers.play)
                VStack(spacing: 0) {
                    scrubber(player)
                    HStack {
                        Text(RecordingFormatting.clock(Int(scrubbing ?? player.position)))
                        Spacer()
                        Text("-" + RecordingFormatting.clock(remaining(player)))
                    }
                    .font(.caption2.monospacedDigit())
                    .foregroundStyle(Theme.Colors.secondaryText)
                }
                Button { viewModel.send(.cycleRate) } label: {
                    Text(rateText(player.rate)).font(.footnote.weight(.semibold)).frame(minWidth: 34)
                }
                .accessibilityLabel(Text("transcript.rate", bundle: .module))
                .accessibilityIdentifier(RecordingsIdentifiers.rate)
            }
            .padding(Theme.Spacing.small)
            .glassEffect(.regular, in: .rect(cornerRadius: 28))
            .padding(.horizontal, Theme.Spacing.small)
        }
    }

    func scrubber(_ player: TranscriptPlayer) -> some View {
        Slider(
            value: Binding(get: { scrubbing ?? player.position }, set: { scrubbing = $0 }),
            in: 0...max(player.duration, 1)
        ) { editing in
            if !editing, let target = scrubbing {
                viewModel.send(.seek(seconds: target))
                scrubbing = nil
            }
        }
        .accessibilityLabel(Text("transcript.position", bundle: .module))
        .accessibilityIdentifier(RecordingsIdentifiers.scrubber)
    }

    func rateText(_ rate: Float) -> String {
        let text = rate.rounded() == rate ? String(Int(rate)) : rate.formatted(.number.precision(.fractionLength(1)))
        return text + "\u{00D7}"
    }

    func remaining(_ player: TranscriptPlayer) -> Int {
        Int(max(player.duration - (scrubbing ?? player.position), 0))
    }
}
