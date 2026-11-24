import CoreKit
import DesignSystem
import SwiftUI

/// The sheet that adds or changes one schedule: the days it is active, bedtime and wake-up on the dial, its length
/// against the goal, the alarm, and deleting it. Nothing is written until the person confirms; closing it drops the
/// changes. A new schedule starts on the days no other schedule holds.
struct SleepScheduleEditor: View {

    // MARK: - Dependencies
    let plan: SleepPlanItem?
    /// The schedule whose times a new one starts from.
    let template: SleepPlanItem?
    /// The days other schedules hold; taking one moves it from that schedule.
    let otherDays: Set<Int>
    let goalMinutes: Int
    let canDelete: Bool
    let save: (SleepScheduleDraft) -> Void
    let delete: () -> Void

    // MARK: - State
    @State private var draft: SleepScheduleDraft
    private let initial: SleepScheduleDraft
    @State private var confirmsDelete = false
    @Environment(\.dismiss)
    private var dismiss

    // MARK: - Init
    init(
        plan: SleepPlanItem?,
        template: SleepPlanItem? = nil,
        otherDays: Set<Int>,
        goalMinutes: Int,
        canDelete: Bool,
        save: @escaping (SleepScheduleDraft) -> Void,
        delete: @escaping () -> Void
    ) {
        self.plan = plan
        self.template = template
        self.otherDays = otherDays
        self.goalMinutes = goalMinutes
        self.canDelete = canDelete
        self.save = save
        self.delete = delete
        let start = Self.draft(for: plan, otherDays: otherDays, template: template)
        initial = start
        _draft = State(initialValue: start)
    }

    // MARK: - Body
    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: Theme.Spacing.medium) {
                    Text(plan == nil ? "sleep.editor.addTitle" : "sleep.editor.editTitle", bundle: .module)
                        .font(.largeTitle.bold())
                        .padding(.bottom, Theme.Spacing.small)
                    header("sleep.editor.days")
                    SleepDaysPicker(days: $draft.days, otherDays: otherDays)
                    header("sleep.editor.times")
                    timesCard
                    alarmCard
                    if plan != nil, canDelete { deleteButton }
                }
                .padding(.horizontal, Theme.Spacing.medium)
                .padding(.bottom, Theme.Spacing.large)
            }
            .background(Theme.Colors.groupedBackground)
            .toolbar { toolbar }
            .confirmationDialog(
                Text("sleep.editor.delete.confirm", bundle: .module),
                isPresented: $confirmsDelete,
                titleVisibility: .visible
            ) {
                Button(role: .destructive) {
                    delete()
                    dismiss()
                } label: {
                    Text("sleep.editor.delete", bundle: .module)
                }
            }
        }
        .accessibilityIdentifier(SleepIdentifiers.editor)
    }
}

// MARK: - Subviews
private extension SleepScheduleEditor {

    var meetsGoal: Bool {
        draft.durationMinutes >= goalMinutes
    }

    var canSave: Bool {
        !draft.days.isEmpty && (plan == nil || draft != initial)
    }

    func header(_ key: LocalizedStringKey) -> some View {
        Text(key, bundle: .module)
            .font(.headline)
            .foregroundStyle(Theme.Colors.secondaryText)
            .padding(.horizontal, Theme.Spacing.medium)
            .padding(.top, Theme.Spacing.small)
    }

    var timesCard: some View {
        VStack(spacing: Theme.Spacing.medium) {
            HStack(alignment: .top) {
                timeColumn(
                    symbol: "bed.double.fill",
                    symbolColor: Theme.Colors.sleep,
                    title: Text("sleep.editor.bed", bundle: .module),
                    minutes: draft.bedMinutes,
                    emphasized: true
                )
                timeColumn(
                    symbol: "alarm",
                    symbolColor: Theme.Colors.secondaryText,
                    title: draft.alarm
                        ? Text("sleep.editor.alarm", bundle: .module)
                        : Text("sleep.editor.wakeNoAlarm", bundle: .module),
                    minutes: draft.wakeMinutes,
                    emphasized: draft.alarm
                )
            }
            SleepDial(draft: $draft, meetsGoal: meetsGoal)
                .padding(.horizontal, Theme.Spacing.small)
            VStack(spacing: 4) {
                Text(SleepFormat.longDuration(draft.durationMinutes))
                    .font(.title.weight(.semibold))
                    .monospacedDigit()
                goalLine
                    .font(.subheadline)
                    .multilineTextAlignment(.center)
            }
            .padding(.bottom, Theme.Spacing.small)
        }
        .padding(Theme.Spacing.medium)
        .background(Theme.Colors.card, in: RoundedRectangle(cornerRadius: 28, style: .continuous))
    }

    func timeColumn(symbol: String, symbolColor: Color, title: Text, minutes: Int, emphasized: Bool) -> some View {
        VStack(spacing: 2) {
            Label { title } icon: { Image(systemName: symbol).foregroundStyle(symbolColor) }
                .font(.footnote.weight(.semibold))
                .textCase(.uppercase)
                .foregroundStyle(Theme.Colors.secondaryText)
                .lineLimit(1)
                .minimumScaleFactor(0.7)
            Text(SleepFormat.time(minutes))
                .font(.system(size: 34, weight: .bold, design: .rounded))
                .monospacedDigit()
                .foregroundStyle(emphasized ? Color.primary : Theme.Colors.secondaryText)
                .contentTransition(.numericText())
        }
        .frame(maxWidth: .infinity)
    }

    @ViewBuilder var goalLine: some View {
        if meetsGoal {
            Text("sleep.editor.goal.met", bundle: .module)
                .foregroundStyle(Theme.Colors.secondaryText)
        } else {
            Label {
                Text("sleep.editor.goal.missed", bundle: .module)
            } icon: {
                Image(systemName: "exclamationmark.circle.fill").foregroundStyle(.orange)
            }
            .foregroundStyle(Theme.Colors.secondaryText)
        }
    }

    var alarmCard: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.small) {
            header("sleep.editor.alarmOptions")
            Toggle(isOn: $draft.alarm) { Text("sleep.editor.alarmToggle", bundle: .module) }
                .padding(Theme.Spacing.medium)
                .background(Theme.Colors.card, in: RoundedRectangle(cornerRadius: 26, style: .continuous))
                .accessibilityIdentifier(SleepIdentifiers.alarm)
        }
    }

    var deleteButton: some View {
        Button(role: .destructive) { confirmsDelete = true } label: {
            Text("sleep.editor.delete", bundle: .module)
                .frame(maxWidth: .infinity)
                .padding(Theme.Spacing.medium)
                .background(Theme.Colors.card, in: RoundedRectangle(cornerRadius: 26, style: .continuous))
        }
        .buttonStyle(.plain)
        .foregroundStyle(Theme.Colors.destructive)
        .padding(.top, Theme.Spacing.small)
        .accessibilityIdentifier(SleepIdentifiers.deletePlan)
    }

    @ToolbarContentBuilder var toolbar: some ToolbarContent {
        ToolbarItem(placement: .cancellationAction) {
            Button { dismiss() } label: {
                Label { Text("sleep.close", bundle: .module) } icon: { Image(systemName: "xmark") }
            }
            .accessibilityIdentifier(SleepIdentifiers.editorClose)
        }
        ToolbarItem(placement: .confirmationAction) {
            Group {
                if plan == nil {
                    Button { confirm() } label: { Text("sleep.editor.add", bundle: .module) }
                } else {
                    Button { confirm() } label: {
                        Label { Text("sleep.done", bundle: .module) } icon: { Image(systemName: "checkmark") }
                    }
                }
            }
            .buttonStyle(.borderedProminent)
            .disabled(!canSave)
            .accessibilityIdentifier(SleepIdentifiers.editorConfirm)
        }
    }

    func confirm() {
        save(draft)
        dismiss()
    }

    /// The schedule the editor starts from: the plan as it is, or a new one on the days no schedule holds, at the
    /// times of `template` (the first schedule), else from 23:00 to 7:00, without an alarm.
    static func draft(for plan: SleepPlanItem?, otherDays: Set<Int>, template: SleepPlanItem?) -> SleepScheduleDraft {
        if let plan {
            return SleepScheduleDraft(
                days: Set(plan.wakeDays),
                bedMinutes: plan.bedMinutes,
                wakeMinutes: plan.wakeMinutes,
                alarm: plan.alarm
            )
        }
        return SleepScheduleDraft(
            days: Set(1...7).subtracting(otherDays),
            bedMinutes: template?.bedMinutes ?? 23 * 60,
            wakeMinutes: template?.wakeMinutes ?? 7 * 60,
            alarm: false
        )
    }
}

// MARK: - Preview
#Preview("Edit") {
    SleepScheduleEditor(
        plan: SleepState.previewReady.plans.first,
        otherDays: [6, 7],
        goalMinutes: 450,
        canDelete: true,
        save: { _ in },
        delete: {}
    )
}

#Preview("Add") {
    SleepScheduleEditor(plan: nil, otherDays: [1, 2, 3, 4, 5], goalMinutes: 450, canDelete: false, save: { _ in },
                        delete: {})
}
