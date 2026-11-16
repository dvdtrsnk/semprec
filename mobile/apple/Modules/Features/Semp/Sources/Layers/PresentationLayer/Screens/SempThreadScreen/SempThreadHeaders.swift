import CoreKit
import DesignSystem
import SwiftUI

/// The empty chat: what Semp can be asked, as four starting points that send themselves.
struct SempEmptyChatView: View {

    // MARK: - Dependencies
    let send: (SempThreadAction) -> Void

    // MARK: - Body
    var body: some View {
        VStack(spacing: Theme.Spacing.medium) {
            Image(systemName: "sparkles").font(.largeTitle).foregroundStyle(Theme.Colors.accent)
            Text("semp.empty.title", bundle: .module).font(Theme.Typography.title)
            Text("semp.empty.text", bundle: .module)
                .multilineTextAlignment(.center)
                .foregroundStyle(.secondary)
            VStack(spacing: 8) {
                ForEach(Array(suggestions.enumerated()), id: \.offset) { index, suggestion in
                    Button { send(.send(suggestion.title)) } label: {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(suggestion.title).font(.body.weight(.medium))
                            Text(suggestion.subtitle).font(.footnote).foregroundStyle(.secondary)
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(12)
                        .background(Theme.Colors.card, in: RoundedRectangle(cornerRadius: 16))
                    }
                    .buttonStyle(.plain)
                    .accessibilityIdentifier(SempIdentifiers.suggestionPrefix + String(index))
                }
            }
        }
        .padding(.top, Theme.Spacing.large)
    }

    // MARK: - Suggestions
    private var suggestions: [(title: String, subtitle: String)] {
        [
            (
                String(localized: "semp.suggestion.today", bundle: .module),
                String(localized: "semp.suggestion.today.sub", bundle: .module)
            ),
            (
                String(localized: "semp.suggestion.inbox", bundle: .module),
                String(localized: "semp.suggestion.inbox.sub", bundle: .module)
            ),
            (
                String(localized: "semp.suggestion.week", bundle: .module),
                String(localized: "semp.suggestion.week.sub", bundle: .module)
            ),
            (
                String(localized: "semp.suggestion.project", bundle: .module),
                String(localized: "semp.suggestion.project.sub", bundle: .module)
            )
        ]
    }
}

/// What the thread of an Inbox item is about, with the note that it changes only that item.
struct SempSubjectHeader: View {

    // MARK: - Dependencies
    let subject: SempSubject?

    // MARK: - Body
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 12) {
                Image(systemName: SempTargetKind.inbox.symbol)
                    .foregroundStyle(SempTargetKind.inbox.color)
                    .frame(width: 36, height: 36)
                    .background(SempTargetKind.inbox.color.opacity(0.14), in: RoundedRectangle(cornerRadius: 10))
                VStack(alignment: .leading, spacing: 2) {
                    Text(caption).font(.caption).foregroundStyle(.secondary)
                    Text(subject?.title ?? String(localized: "semp.subject.untitled", bundle: .module))
                        .font(.subheadline.weight(.semibold))
                }
            }
            Text("semp.subject.note", bundle: .module).font(.footnote).foregroundStyle(.secondary)
        }
        .padding(Theme.Spacing.medium)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.Colors.card, in: RoundedRectangle(cornerRadius: 18))
    }

    private var caption: String {
        let kind = String(localized: "semp.subject.kind", bundle: .module)
        guard let meta = subject?.meta else { return kind }
        return "\(kind) · \(meta)"
    }
}

/// The automatic task behind a tick thread, with the button that runs it again.
struct SempTickHeader: View {

    // MARK: - Dependencies
    let tick: SempTickInfo
    let send: (SempThreadAction) -> Void

    // MARK: - Body
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 12) {
                Image(systemName: "clock.arrow.circlepath")
                    .foregroundStyle(Theme.Colors.accent)
                    .frame(width: 36, height: 36)
                    .background(Theme.Colors.accent.opacity(0.14), in: RoundedRectangle(cornerRadius: 10))
                VStack(alignment: .leading, spacing: 2) {
                    Text(tick.name).font(.subheadline.weight(.semibold))
                    Text(subtitle).font(.caption).foregroundStyle(.secondary)
                }
                Spacer(minLength: 0)
            }
            Text("semp.tick.note", bundle: .module).font(.footnote).foregroundStyle(.secondary)
            if tick.triggerFailed {
                Text("semp.tick.triggerFailed", bundle: .module)
                    .font(.footnote)
                    .foregroundStyle(Theme.Colors.destructive)
            }
            if tick.canTrigger {
                Button { send(.runAgain) } label: {
                    if tick.running {
                        HStack(spacing: 6) {
                            ProgressView().controlSize(.small)
                            Text("semp.tick.running", bundle: .module)
                        }
                    } else {
                        Label { Text("semp.tick.runAgain", bundle: .module) } icon: { Image(systemName: "play.fill") }
                    }
                }
                .buttonStyle(.bordered)
                .disabled(tick.running)
                .accessibilityIdentifier(SempIdentifiers.runAgain)
            }
        }
        .padding(Theme.Spacing.medium)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.Colors.card, in: RoundedRectangle(cornerRadius: 18))
    }

    private var subtitle: String {
        let kind = String(localized: "semp.tick.kind", bundle: .module)
        guard let project = tick.projectName else { return kind }
        return String(
            format: String(localized: "semp.tick.inProject", bundle: .module),
            locale: .current,
            kind,
            project
        )
    }
}
