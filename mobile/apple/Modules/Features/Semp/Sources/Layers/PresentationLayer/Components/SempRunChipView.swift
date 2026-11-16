import CoreKit
import DesignSystem
import SwiftUI

/// What Semp did for one reply: a line with the number of steps and how long they took, which opens into the steps and
/// a link to the whole run.
struct SempRunChipView: View {

    // MARK: - Dependencies
    let chip: SempRunChip
    let toggle: () -> Void
    let openRun: () -> Void

    // MARK: - Body
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Button(action: toggle) {
                HStack(spacing: 6) {
                    Image(systemName: "wrench.and.screwdriver").imageScale(.small)
                    Text(summary).font(.footnote).foregroundStyle(summaryColor)
                    Image(systemName: "chevron.right")
                        .imageScale(.small)
                        .rotationEffect(.degrees(chip.expanded ? 90 : 0))
                }
                .foregroundStyle(.secondary)
            }
            .buttonStyle(.plain)
            .accessibilityValue(Text(chip.expanded ? "semp.run.expanded" : "semp.run.collapsed", bundle: .module))
            .accessibilityIdentifier(SempIdentifiers.runChipPrefix + chip.messageId)
            if chip.expanded { steps }
        }
    }
}

// MARK: - Subviews
private extension SempRunChipView {

    var summary: String {
        let steps = String(
            format: String(localized: "semp.run.steps", bundle: .module),
            locale: .current,
            chip.stepCount
        )
        let time = SempTime.duration(milliseconds: chip.durationMs)
        switch chip.state {
        case .ok: return "\(steps) · \(time)"
        case .waitingApproval: return "\(steps) · \(String(localized: "semp.run.waiting", bundle: .module))"
        case .failed: return "\(steps) · \(String(localized: "semp.run.failed", bundle: .module))"
        }
    }

    var summaryColor: Color {
        switch chip.state {
        case .ok: Theme.Colors.secondaryText
        case .waitingApproval: Theme.Colors.sempWaiting
        case .failed: Theme.Colors.destructive
        }
    }

    var steps: some View {
        VStack(alignment: .leading, spacing: 8) {
            switch chip.stepsPhase {
            case .none, .loading:
                ProgressView().controlSize(.small)
            case .error:
                Text("semp.run.stepsFailed", bundle: .module).font(.footnote).foregroundStyle(.secondary)
            case .ready:
                ForEach(chip.steps) { line in
                    SempStepLineView(line: line)
                }
            }
            Button(action: openRun) {
                Text("semp.run.whole", bundle: .module).font(.footnote)
            }
            .buttonStyle(.plain)
            .foregroundStyle(Theme.Colors.accent)
        }
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.quaternary.opacity(0.5), in: RoundedRectangle(cornerRadius: 14))
    }
}

/// One step of a run in a list: a colored dot, what happened and how long it took.
struct SempStepLineView: View {

    // MARK: - Dependencies
    let line: SempStepLine

    // MARK: - Body
    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            Image(systemName: symbol).foregroundStyle(color).imageScale(.small)
            VStack(alignment: .leading, spacing: 2) {
                Text(line.title).font(.footnote.weight(.medium))
                if let summary = line.summary {
                    Text(summary).font(.caption).foregroundStyle(.secondary)
                }
            }
            Spacer(minLength: 0)
            if let duration = line.durationMs {
                Text(SempTime.duration(milliseconds: duration)).font(.caption).foregroundStyle(.secondary)
            }
        }
        .accessibilityElement(children: .combine)
    }

    private var symbol: String {
        switch line.state {
        case .ok: "checkmark.circle.fill"
        case .running: "ellipsis.circle"
        case .error: "exclamationmark.circle.fill"
        case .waitingApproval: "clock.fill"
        }
    }

    private var color: Color {
        switch line.state {
        case .ok: Theme.Colors.sempSuccess
        case .running: Theme.Colors.secondaryText
        case .error: Theme.Colors.destructive
        case .waitingApproval: Theme.Colors.sempWaiting
        }
    }
}

#Preview {
    SempRunChipView(
        chip: SempRunChip(
            runId: "r1",
            messageId: "m1",
            stepCount: 3,
            durationMs: 4_100,
            state: .ok,
            expanded: true,
            stepsPhase: .ready,
            steps: [
                SempStepLine(id: "1", state: .ok, title: "Hledání v úkolech", summary: "„faktura“", durationMs: 400)
            ]
        ),
        toggle: {},
        openRun: {}
    )
    .padding()
}
