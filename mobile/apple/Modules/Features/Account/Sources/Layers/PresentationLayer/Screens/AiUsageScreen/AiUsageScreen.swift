import CoreKit
import DesignSystem
import SwiftUI

/// The AI spend of a period: the total against the caps of the server, a bar per day or month, and what each model
/// and each kind of work cost. Prices are in US dollars as the providers charge them.
struct AiUsageScreen: View {

    // MARK: - Dependencies
    @StateObject private var viewModel: AiUsageViewModel

    // MARK: - Init
    /// `viewModel` runs once per screen, when SwiftUI creates the state object.
    init(viewModel: @autoclosure @escaping () -> AiUsageViewModel) {
        _viewModel = StateObject(wrappedValue: viewModel())
    }

    // MARK: - Body
    var body: some View {
        VStack(spacing: 0) {
            periods
            content
        }
        .background(Theme.Colors.groupedBackground)
        .navigationTitle(Text("usage.title", bundle: .module))
        .inlineNavigationTitle()
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier(AccountIdentifiers.usageScreen)
        .task { await viewModel.observe() }
    }
}

// MARK: - Subviews
private extension AiUsageScreen {

    var periods: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: Theme.Spacing.small) {
                ForEach(viewModel.state.periods, id: \.self) { period in
                    let selected = period == viewModel.state.period
                    Button { viewModel.select(period) } label: {
                        Text(AiUsageFormat.chip(period))
                            .font(.subheadline.weight(selected ? .semibold : .regular))
                            .padding(.horizontal, Theme.Spacing.medium)
                            .padding(.vertical, 6)
                            .foregroundStyle(selected ? AnyShapeStyle(.background) : AnyShapeStyle(.primary))
                            .background(selected ? Theme.Colors.brand : Theme.Colors.card, in: Capsule())
                    }
                    .buttonStyle(.plain)
                    .accessibilityAddTraits(selected ? .isSelected : [])
                    .accessibilityIdentifier(AccountIdentifiers.usagePeriodPrefix + AiUsageScreen.identifier(period))
                }
            }
            .padding(.horizontal, Theme.Spacing.medium)
            .padding(.vertical, Theme.Spacing.small)
        }
    }

    @ViewBuilder var content: some View {
        switch viewModel.state.phase {
        case .loading:
            StatusView(.loading)
        case .error:
            StatusView(
                .failure(message: Text(FailureKind.message(for: viewModel.state.failure)), retry: { viewModel.retry() })
            )
        case .content:
            ScrollView {
                VStack(alignment: .leading, spacing: Theme.Spacing.large) {
                    totals
                    if !viewModel.state.models.isEmpty { models }
                    if !viewModel.state.operations.isEmpty { operations }
                    Text("usage.footer", bundle: .module)
                        .font(.footnote)
                        .foregroundStyle(Theme.Colors.secondaryText)
                }
                .padding(Theme.Spacing.medium)
            }
        }
    }

    var totals: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.medium) {
            VStack(alignment: .leading, spacing: 2) {
                Text(totalLabel).font(.subheadline).foregroundStyle(Theme.Colors.secondaryText)
                Text(AiUsageFormat.usd(viewModel.state.totalUsd))
                    .font(.largeTitle.weight(.bold))
                    .accessibilityIdentifier(AccountIdentifiers.usageTotal)
                if viewModel.state.estimated {
                    Text("usage.estimated", bundle: .module).font(.footnote).foregroundStyle(Theme.Colors.secondaryText)
                }
            }
            if let budget = budgetText { budget }
            UsageBars(points: viewModel.state.points, picked: viewModel.state.picked) { viewModel.pick($0) }
            HStack {
                Text(viewModel.state.points.first.map { AiUsageFormat.pointLabel($0.key) } ?? "")
                Spacer()
                Text(pickedText)
                Spacer()
                Text(viewModel.state.points.last.map { AiUsageFormat.pointLabel($0.key) } ?? "")
            }
            .font(.caption)
            .foregroundStyle(Theme.Colors.secondaryText)
        }
        .padding(Theme.Spacing.medium)
        .background(Theme.Colors.card, in: RoundedRectangle(cornerRadius: Theme.Radius.card, style: .continuous))
    }

    var models: some View {
        card(title: "usage.section.models") {
            let top = viewModel.state.models.map(\.costUsd).max() ?? 0
            ForEach(Array(viewModel.state.models.enumerated()), id: \.offset) { _, model in
                VStack(alignment: .leading, spacing: 4) {
                    HStack {
                        Text(model.name)
                        Spacer()
                        Text(AiUsageFormat.usd(model.costUsd)).monospacedDigit()
                    }
                    ProgressView(value: top > 0 ? model.costUsd / top : 0).tint(.primary)
                    Text(Self.meta(of: model)).font(.footnote).foregroundStyle(Theme.Colors.secondaryText)
                }
            }
        }
    }

    var operations: some View {
        card(title: "usage.section.operations") {
            ForEach(Array(viewModel.state.operations.enumerated()), id: \.offset) { _, operation in
                HStack {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(operation.label)
                        Text(AiUsageFormat.percent(operation.share))
                            .font(.footnote)
                            .foregroundStyle(Theme.Colors.secondaryText)
                    }
                    Spacer()
                    Text(AiUsageFormat.usd(operation.costUsd)).monospacedDigit()
                }
            }
        }
    }

    func card<Rows: View>(title: LocalizedStringKey, @ViewBuilder rows: () -> Rows) -> some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.small) {
            Text(title, bundle: .module).font(.title3.weight(.bold))
            VStack(alignment: .leading, spacing: Theme.Spacing.medium) { rows() }
                .padding(Theme.Spacing.medium)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(
                    Theme.Colors.card,
                    in: RoundedRectangle(cornerRadius: Theme.Radius.card, style: .continuous)
                )
        }
    }

    var totalLabel: String {
        switch viewModel.state.period {
        case .week:
            String(localized: "usage.total.week", bundle: .module)
        case .all:
            String(
                format: String(localized: "usage.total.all", bundle: .module),
                viewModel.state.accountStartedAt.flatMap { AccountFormat.day($0) } ?? ""
            )
        case .month(let month):
            AiUsageFormat.monthName(month) ?? month
        }
    }

    var budgetText: Text? {
        guard case .month = viewModel.state.period else { return nil }
        guard let cap = viewModel.state.caps?.monthlyUsd, cap > 0 else { return nil }
        let spent = AiUsageFormat.usd(viewModel.state.totalUsd)
        return Text(
            String(format: String(localized: "usage.budget", bundle: .module), spent, AiUsageFormat.usd(cap))
        )
    }

    var pickedText: String {
        guard let index = viewModel.state.picked, viewModel.state.points.indices.contains(index) else {
            return String(localized: "usage.pick", bundle: .module)
        }
        let point = viewModel.state.points[index]
        return AiUsageFormat.pointLabel(point.key) + " · " + AiUsageFormat.usd(point.costUsd)
    }

    static func meta(of model: UsageModelItem) -> String {
        var parts = [String(format: String(localized: "usage.calls", bundle: .module), model.callCount)]
        if let input = model.inputTokens, let output = model.outputTokens {
            parts.append(
                AiUsageFormat.tokens(input + output) + " " + String(localized: "usage.tokens", bundle: .module)
            )
        }
        if let seconds = model.audioSeconds {
            parts.append(AiUsageFormat.minutes(seconds) + " " + String(localized: "usage.minutes", bundle: .module))
        }
        return parts.joined(separator: " · ")
    }

    static func identifier(_ period: UsagePeriod) -> String {
        switch period {
        case .week: "week"
        case .all: "all"
        case .month(let month): month
        }
    }
}

// MARK: - Preview
#Preview {
    NavigationStack {
        AiUsageScreen(
            viewModel: AiUsageViewModel(
                model: ScriptedAiUsageScreenModel(
                    state: AiUsageState(
                        phase: .content,
                        periods: [.week, .all, .month("2026-10")],
                        accountStartedAt: "2026-06-03T08:00:00Z",
                        totalUsd: 24.12,
                        points: (1...7).map { UsagePointItem(key: "2026-10-0\($0)", costUsd: Double($0)) },
                        models: [
                            UsageModelItem(
                                name: "Claude Sonnet",
                                costUsd: 14,
                                callCount: 820,
                                inputTokens: 3_000_000,
                                outputTokens: 900_000,
                                audioSeconds: nil
                            )
                        ],
                        operations: [UsageOperationItem(label: "Semp chat", costUsd: 15, share: 0.62, callCount: 900)]
                    )
                )
            )
        )
    }
}
