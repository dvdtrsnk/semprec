import CoreKit
import DesignSystem
import SwiftUI

// MARK: - Tasks
extension MeetingScreen {

    var tasksSection: some View {
        Section {
            ForEach(state.tasks) { task in
                taskRow(task)
            }
            ForEach(state.suggestions) { suggestion in
                suggestionRow(suggestion)
            }
            newTaskRow
        } header: {
            Text("meeting.tasks", bundle: .module)
        } footer: {
            Text(chainNote)
        }
    }

    func taskRow(_ task: MeetingTaskRow) -> some View {
        HStack(spacing: Theme.Spacing.small) {
            Button { viewModel.send(.toggleTask(taskId: task.id)) } label: {
                Image(systemName: task.status == .done ? "checkmark.circle.fill" : "circle")
                    .foregroundStyle(task.status == .done ? Color.green : Theme.Colors.secondaryText)
                    .font(.title3)
            }
            .buttonStyle(.plain)
            .disabled(task.busy || task.status == .doneElsewhere || task.status == .moved)
            .accessibilityLabel(Text("meeting.task.done", bundle: .module))
            Button { viewModel.send(.openTask(taskId: task.id)) } label: {
                VStack(alignment: .leading, spacing: 2) {
                    Text(task.title).strikethrough(task.status == .done)
                    if let note = statusNote(task) {
                        Text(note).font(.footnote).foregroundStyle(statusColor(task))
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier(RecordingsIdentifiers.taskPrefix + task.id)
    }

    func statusNote(_ task: MeetingTaskRow) -> String? {
        let detail = task.detail ?? ""
        switch task.status {
        case .open, .done: return nil
        case .missed: return String(localized: "meeting.task.missed", bundle: .module)
        case .doneElsewhere:
            return String(format: String(localized: "meeting.task.doneElsewhere", bundle: .module), detail)
        case .moved: return String(format: String(localized: "meeting.task.moved", bundle: .module), detail)
        }
    }

    func statusColor(_ task: MeetingTaskRow) -> Color {
        task.status == .missed ? Theme.Colors.destructive : Theme.Colors.secondaryText
    }

    func suggestionRow(_ suggestion: MeetingSuggestionRow) -> some View {
        HStack(spacing: Theme.Spacing.small) {
            Image(systemName: "sparkles").foregroundStyle(Theme.Colors.accent)
            VStack(alignment: .leading, spacing: 2) {
                Text(suggestion.text)
                Text(suggestionMeta(suggestion)).font(.footnote).foregroundStyle(Theme.Colors.secondaryText)
            }
            Spacer()
            Button {
                viewModel.send(
                    .addSuggestion(transcriptId: suggestion.transcriptId, actionItemId: suggestion.actionItemId)
                )
            } label: {
                Text("meeting.suggestion.add", bundle: .module)
            }
            .buttonStyle(.bordered)
            .disabled(suggestion.busy)
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier(RecordingsIdentifiers.suggestionPrefix + suggestion.id)
    }

    func suggestionMeta(_ suggestion: MeetingSuggestionRow) -> String {
        let parts = [
            String(localized: "meeting.suggestion.fromTranscript", bundle: .module),
            suggestion.ownerLabel,
            RecordingFormatting.due(suggestion.due)
        ]
        return parts.compactMap { $0 }.joined(separator: " \u{00B7} ")
    }

    var newTaskRow: some View {
        HStack {
            Image(systemName: "plus").foregroundStyle(Theme.Colors.accent)
            TextField(text: $draft) { Text("meeting.newTask", bundle: .module) }
                .onSubmit {
                    viewModel.send(.addTask(title: draft))
                    draft = ""
                }
                .submitLabel(.done)
                .accessibilityIdentifier(RecordingsIdentifiers.newTask)
        }
    }

    var chainNote: String {
        guard let project = state.projectName else {
            return String(localized: "meeting.tasks.noteNoProject", bundle: .module)
        }
        return String(format: String(localized: "meeting.tasks.note", bundle: .module), project)
    }
}

// MARK: - Notes and recordings
extension MeetingScreen {

    var notesSection: some View {
        Section {
            Button { viewModel.send(.openNotes) } label: {
                Label { Text("meeting.notes.open", bundle: .module) } icon: { Image(systemName: "note.text") }
                    .foregroundStyle(Color.primary)
            }
            .listRowButton()
            .accessibilityIdentifier(RecordingsIdentifiers.notes)
        } header: {
            Text("meeting.notes", bundle: .module)
        }
    }

    var recordingsSection: some View {
        Section {
            ForEach(state.recordings) { row in
                recordingRow(row)
            }
            Button { recorder.send(.start) } label: {
                recordLabel(
                    title: state.recordings.isEmpty ? "meeting.record.first" : "meeting.record.more",
                    subtitle: "meeting.record.subtitle",
                    symbol: "record.circle"
                )
            }
            .listRowButton()
            .disabled(recorder.state.phase != .idle)
            .accessibilityIdentifier(RecordingsIdentifiers.recordEvent)
            Button { importing = true } label: {
                recordLabel(
                    title: "meeting.import",
                    subtitle: "meeting.import.subtitle",
                    symbol: "square.and.arrow.down"
                )
            }
            .listRowButton()
            .disabled(recorder.state.phase != .idle)
            .accessibilityIdentifier(RecordingsIdentifiers.importEvent)
        } header: {
            Text("meeting.recordings", bundle: .module)
        }
    }

    func recordingRow(_ row: RecordingRow) -> some View {
        Button { viewModel.send(.openRecording(recordingId: row.id)) } label: {
            VStack(alignment: .leading, spacing: 4) {
                Label { Text("meeting.recording.open", bundle: .module) } icon: { Image(systemName: "waveform") }
                    .font(.headline)
                    .foregroundStyle(Color.primary)
                Text(recordingDetails(row)).font(.subheadline).foregroundStyle(Theme.Colors.secondaryText)
                if row.processing {
                    HStack(spacing: 6) {
                        ProgressView().controlSize(.mini)
                        Text("meeting.recording.processing", bundle: .module)
                            .font(.footnote)
                            .foregroundStyle(Theme.Colors.secondaryText)
                    }
                } else if let summary = row.shortSummary {
                    Text(summary).font(.footnote).foregroundStyle(Theme.Colors.secondaryText)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .contentShape(Rectangle())
        }
        .listRowButton()
        .accessibilityIdentifier(RecordingsIdentifiers.recordingRowPrefix + row.id)
    }

    func recordingDetails(_ row: RecordingRow) -> String {
        [RecordingFormatting.when(row.date), row.durationSeconds.map(RecordingFormatting.clock)]
            .compactMap { $0 }
            .joined(separator: " \u{00B7} ")
    }

    func recordLabel(title: LocalizedStringKey, subtitle: LocalizedStringKey, symbol: String) -> some View {
        Label {
            VStack(alignment: .leading, spacing: 2) {
                Text(title, bundle: .module).foregroundStyle(Color.primary)
                Text(subtitle, bundle: .module).font(.footnote).foregroundStyle(Theme.Colors.secondaryText)
            }
        } icon: {
            Image(systemName: symbol).foregroundStyle(Theme.Colors.destructive)
        }
    }
}

// MARK: - People and context
extension MeetingScreen {

    var peopleSection: some View {
        Section {
            if state.people.isEmpty {
                Text("meeting.people.none", bundle: .module).foregroundStyle(Theme.Colors.secondaryText)
            }
            ForEach(state.people) { person in
                Label {
                    Text(person.name)
                } icon: {
                    Text(RecordingFormatting.initials(person.name))
                        .font(.caption.weight(.semibold))
                        .frame(width: 32, height: 32)
                        .background(Theme.Colors.accent.opacity(0.15), in: Circle())
                }
            }
        } header: {
            Text("meeting.people", bundle: .module)
        }
    }

    var contextSection: some View {
        Section {
            LabeledContent {
                Text(state.projectName ?? String(localized: "meeting.context.noProject", bundle: .module))
                    .foregroundStyle(Theme.Colors.secondaryText)
            } label: {
                Text("meeting.context.project", bundle: .module)
            }
            LabeledContent {
                Text(state.companyName ?? String(localized: "meeting.context.noCompany", bundle: .module))
                    .foregroundStyle(Theme.Colors.secondaryText)
            } label: {
                Text("meeting.context.company", bundle: .module)
            }
        } header: {
            Text("meeting.context", bundle: .module)
        }
    }
}
