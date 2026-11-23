import CoreKit
import DesignSystem
import SwiftUI

/// The banner above the tabs of a signed-in scene: that the scene is offline, with how many changes wait to be sent,
/// and how many changes the server refused, until they are dismissed. It shows nothing while the scene is online and
/// no change was refused.
struct SyncStatusBanner: View {

    // MARK: - Dependencies
    @StateObject private var viewModel: SyncStatusViewModel

    // MARK: - Init
    /// `viewModel` runs once per banner, when SwiftUI creates the state object.
    init(viewModel: @autoclosure @escaping () -> SyncStatusViewModel) {
        _viewModel = StateObject(wrappedValue: viewModel())
    }

    // MARK: - Body
    var body: some View {
        let lines = SyncStatusLine.lines(for: viewModel.state)
        VStack(spacing: 0) {
            ForEach(lines, id: \.self) { line in
                row(line)
            }
        }
        .frame(maxWidth: .infinity)
        // The background reaches under the status bar; with no line it is clear, so the screen below draws there.
        .background(lines.isEmpty ? AnyShapeStyle(.clear) : AnyShapeStyle(.bar))
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier(AppIdentifiers.syncStatus)
        .task { await viewModel.observe() }
    }
}

// MARK: - Subviews
private extension SyncStatusBanner {

    @ViewBuilder
    func row(_ line: SyncStatusLine) -> some View {
        switch line {
        case .offline(let waiting):
            Label {
                Text(Self.offlineText(waiting: waiting))
            } icon: {
                Image(systemName: "wifi.slash")
            }
            .font(Theme.Typography.body)
            .foregroundStyle(Theme.Colors.secondaryText)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, Theme.Spacing.medium)
            .padding(.vertical, Theme.Spacing.small)
            .accessibilityIdentifier(AppIdentifiers.syncOffline)
        case .failed(let count):
            HStack(spacing: Theme.Spacing.small) {
                Label {
                    Text(Self.failedText(count: count))
                } icon: {
                    Image(systemName: "exclamationmark.triangle")
                }
                .foregroundStyle(Theme.Colors.destructive)
                Spacer(minLength: 0)
                Button { viewModel.dismissFailures() } label: { Text("sync.dismiss") }
                    .accessibilityIdentifier(AppIdentifiers.syncDismiss)
            }
            .font(Theme.Typography.body)
            .padding(.horizontal, Theme.Spacing.medium)
            .padding(.vertical, Theme.Spacing.small)
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier(AppIdentifiers.syncFailed)
        }
    }

    static func offlineText(waiting: Int) -> String {
        if waiting == 0 {
            String(localized: "sync.offline.saved")
        } else {
            String(format: String(localized: "sync.offline.waiting"), locale: .current, waiting)
        }
    }

    static func failedText(count: Int) -> String {
        String(format: String(localized: "sync.failed"), locale: .current, count)
    }
}

// MARK: - Preview
#Preview("Offline with changes waiting") {
    SyncStatusBanner(
        viewModel: SyncStatusViewModel(
            model: ScriptedSyncStatusScreenModel(state: SyncStatusState(offline: true, waiting: 3, failed: 2))
        )
    )
}

#Preview("Offline") {
    SyncStatusBanner(
        viewModel: SyncStatusViewModel(
            model: ScriptedSyncStatusScreenModel(state: SyncStatusState(offline: true, waiting: 0, failed: 0))
        )
    )
}
