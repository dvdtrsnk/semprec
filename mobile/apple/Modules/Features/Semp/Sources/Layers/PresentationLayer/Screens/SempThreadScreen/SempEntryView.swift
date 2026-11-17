import CoreKit
import DesignSystem
import SwiftUI

/// One line of the conversation: the person's message on the right, Semp's reply on the left with what it did.
struct SempEntryView: View {

    // MARK: - Dependencies
    let entry: SempEntry
    let type: SempThreadType
    let send: (SempThreadAction) -> Void

    // MARK: - Body
    var body: some View {
        Group {
            switch entry.role {
            case .user: userMessage
            case .assistant: assistantMessage
            case .system: systemMessage
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier(SempIdentifiers.entryPrefix + entry.id)
    }
}

// MARK: - Subviews
private extension SempEntryView {

    var userMessage: some View {
        VStack(alignment: .trailing, spacing: 6) {
            if !entry.chips.isEmpty {
                HStack { ForEach(Array(entry.chips.enumerated()), id: \.offset) { _, chip in chipView(chip) } }
            }
            if let text = entry.text {
                Text(text)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 10)
                    .background(.quaternary, in: RoundedRectangle(cornerRadius: 20))
                    .opacity(entry.delivery == .sending ? 0.6 : 1)
            }
            if entry.delivery == .failed { failedDelivery }
        }
        .frame(maxWidth: .infinity, alignment: .trailing)
    }

    func chipView(_ chip: SempChip) -> some View {
        SempChipView(kind: chip.kind, label: chip.label, exists: chip.exists)
    }

    var failedDelivery: some View {
        VStack(alignment: .trailing, spacing: 6) {
            Label(FailureKind.sempMessage(for: entry.deliveryFailure), systemImage: "exclamationmark.circle")
                .font(.footnote)
                .foregroundStyle(Theme.Colors.destructive)
            HStack {
                Button { send(.resolveUnsent(id: entry.id, retry: false)) } label: {
                    Text("semp.send.discard", bundle: .module)
                }
                .accessibilityIdentifier(SempIdentifiers.discardSend)
                Button { send(.resolveUnsent(id: entry.id, retry: true)) } label: {
                    Text("semp.send.retry", bundle: .module)
                }
                .buttonStyle(.borderedProminent)
                .accessibilityIdentifier(SempIdentifiers.retrySend)
            }
            .buttonStyle(.bordered)
            .controlSize(.small)
        }
    }

    var assistantMessage: some View {
        VStack(alignment: .leading, spacing: 10) {
            if let run = entry.run {
                SempRunChipView(
                    chip: run,
                    toggle: { send(.toggleRun(messageId: run.messageId)) },
                    openRun: { send(.open(.run(runId: run.runId, messageId: run.messageId))) }
                )
            }
            switch entry.replyPhase {
            case .thinking: progress(String(localized: "semp.reply.thinking", bundle: .module))
            case .working: progress(String(localized: "semp.reply.working", bundle: .module))
            case .failed: failedReply
            case .done: EmptyView()
            }
            if let text = entry.text, !text.isEmpty { SempMarkdownText(text: text) }
            ForEach(entry.changes) { change in changeCard(change) }
            ForEach(entry.approvals) { item in
                SempApprovalCard(item: item) { approve in
                    send(.decide(approvalId: item.id, approve: approve))
                }
            }
            if entry.incomplete { incompleteNote }
            if entry.replyPhase == .done, entry.canRegenerate { replyActions }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    func progress(_ text: String) -> some View {
        HStack(spacing: 8) {
            ProgressView().controlSize(.small)
            Text(text).font(.footnote).foregroundStyle(.secondary)
        }
        .accessibilityElement(children: .combine)
    }

    var failedReply: some View {
        VStack(alignment: .leading, spacing: 8) {
            Label {
                Text("semp.reply.failed", bundle: .module)
            } icon: {
                Image(systemName: "exclamationmark.circle")
            }
            .font(.subheadline.weight(.semibold))
            .foregroundStyle(Theme.Colors.destructive)
            if let message = entry.failure?.message {
                Text(message).font(.footnote).foregroundStyle(.secondary)
            }
            HStack {
                Button { send(.askAgain(messageId: entry.id, regenerate: false)) } label: {
                    Text("semp.reply.retry", bundle: .module)
                }
                .buttonStyle(.borderedProminent)
                .accessibilityIdentifier(SempIdentifiers.retryReply)
                Button { send(.open(.status)) } label: { Text("semp.reply.details", bundle: .module) }
                    .buttonStyle(.bordered)
            }
            .controlSize(.small)
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.Colors.destructive.opacity(0.08), in: RoundedRectangle(cornerRadius: 16))
    }

    var incompleteNote: some View {
        Label {
            Text("semp.reply.incomplete", bundle: .module)
        } icon: {
            Image(systemName: "exclamationmark.triangle")
        }
        .font(.footnote)
        .foregroundStyle(Theme.Colors.sempWaiting)
    }

    var replyActions: some View {
        HStack(spacing: 16) {
            if let text = entry.text {
                ShareLink(item: text) { Image(systemName: "square.and.arrow.up") }
                    .accessibilityLabel(Text("semp.reply.share", bundle: .module))
            }
            Button { send(.askAgain(messageId: entry.id, regenerate: true)) } label: {
                Image(systemName: "arrow.clockwise")
            }
            .accessibilityLabel(Text("semp.reply.regenerate", bundle: .module))
            .accessibilityIdentifier(SempIdentifiers.regenerate)
        }
        .buttonStyle(.plain)
        .foregroundStyle(.secondary)
    }

    func changeCard(_ change: SempChangeCard) -> some View {
        Button { send(.open(.change(itemId: change.itemId, databaseKey: change.databaseKey))) } label: {
            HStack(spacing: 10) {
                Image(systemName: change.kind.symbol).foregroundStyle(change.kind.color)
                VStack(alignment: .leading, spacing: 2) {
                    Text(change.label ?? String(localized: "semp.chip.gone", bundle: .module))
                        .font(.subheadline.weight(.medium))
                    Text(changeText(change)).font(.caption).foregroundStyle(.secondary)
                }
                Spacer(minLength: 0)
                if change.active { Image(systemName: "chevron.right").imageScale(.small).foregroundStyle(.tertiary) }
            }
            .padding(12)
            .background(Theme.Colors.card, in: RoundedRectangle(cornerRadius: 16))
        }
        .buttonStyle(.plain)
        .disabled(!change.active)
    }

    func changeText(_ change: SempChangeCard) -> String {
        switch change.change {
        case .created: String(localized: "semp.change.created", bundle: .module)
        case .updated: String(localized: "semp.change.updated", bundle: .module)
        case .deleted: String(localized: "semp.change.deleted", bundle: .module)
        case .restored: String(localized: "semp.change.restored", bundle: .module)
        case .revised: String(localized: "semp.change.revised", bundle: .module)
        }
    }

    var systemMessage: some View {
        Text(systemText)
            .font(.footnote)
            .foregroundStyle(.secondary)
            .frame(maxWidth: .infinity, alignment: .center)
            .multilineTextAlignment(.center)
    }

    var systemText: String {
        switch entry.systemKey {
        case "approval.outcome.executed": String(localized: "semp.system.executed", bundle: .module)
        case "approval.outcome.rejected": String(localized: "semp.system.rejected", bundle: .module)
        case "approval.outcome.conflict": String(localized: "semp.system.conflict", bundle: .module)
        default: entry.text ?? String(localized: "semp.system.other", bundle: .module)
        }
    }
}

#Preview {
    VStack(spacing: 16) {
        SempEntryView(
            entry: SempEntry(
                id: "u1",
                role: .user,
                text: "Co mám dnes v plánu?",
                chips: [SempChip(kind: .task, label: "Odeslat fakturu")]
            ),
            type: .chat,
            send: { _ in }
        )
        SempEntryView(
            entry: SempEntry(id: "a1", role: .assistant, text: "Dnes tě čeká:\n- **14:00**", canRegenerate: true),
            type: .chat,
            send: { _ in }
        )
    }
    .padding()
}
