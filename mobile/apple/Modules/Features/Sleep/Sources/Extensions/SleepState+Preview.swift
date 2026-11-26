import CoreKit

// MARK: - Preview data
extension SleepState {

    /// A ready sheet with two plans and a night, for previews.
    static var previewReady: SleepState {
        SleepState(
            phase: .ready,
            goalOptions: [420, 450, 480, 510, 540],
            reminderLeadOptions: [15, 30, 45, 60],
            plans: [
                SleepPlanItem(
                    id: "weekdays", name: "Weekdays", wakeDays: [1, 2, 3, 4, 5], bedMinutes: 1_380, wakeMinutes: 405,
                    durationMinutes: 465, alarm: true
                ),
                SleepPlanItem(
                    id: "weekend", name: "Weekend", wakeDays: [6, 7], bedMinutes: 0, wakeMinutes: 510,
                    durationMinutes: 510, alarm: false
                )
            ],
            night: SleepNightItem(
                night: "2026-10-16", planName: "Weekdays", bedMinutes: 1_380, wakeMinutes: 405, durationMinutes: 465,
                alarm: true, changed: false, reminderMinutes: 1_350
            )
        )
    }

    /// The same sheet on another page; the night page shows the night's draft, `draft` by default the usual night.
    func opening(_ page: SleepPage, draft: SleepDraft = .previewNight) -> SleepState {
        var state = self
        state.page = page
        state.isRoot = page == .main
        state.nightDraft = page == .night ? draft : nil
        return state
    }

    /// The same sheet with the editor open on `draft`.
    func editing(_ draft: SleepDraft) -> SleepState {
        var state = self
        state.editor = draft
        return state
    }
}

// MARK: - Preview drafts
extension SleepDraft {

    /// The weekday plan as the editor opens it: Monday to Friday, 23:00 to 6:45, below the goal.
    static let previewWeekdays = SleepDraft(
        planId: "weekdays", isNew: false, wakeDays: [1, 2, 3, 4, 5], takenDays: [6, 7], bedMinutes: 1_380,
        wakeMinutes: 405, durationMinutes: 465, goalDifferenceMinutes: -15, meetsGoal: false, alarm: true,
        canSave: false, canDelete: true, stepMinutes: 5
    )

    /// The weekend plan: Saturday and Sunday, midnight to 8:30, above the goal.
    static let previewWeekend = SleepDraft(
        planId: "weekend", isNew: false, wakeDays: [6, 7], takenDays: [1, 2, 3, 4, 5], bedMinutes: 0,
        wakeMinutes: 510, durationMinutes: 510, goalDifferenceMinutes: 30, meetsGoal: true, alarm: false,
        canSave: true, canDelete: true, stepMinutes: 5
    )

    /// A new plan on the days no plan holds.
    static let previewNew = SleepDraft(
        planId: nil, isNew: true, wakeDays: [6, 7], takenDays: [1, 2, 3, 4, 5], bedMinutes: 1_380,
        wakeMinutes: 405, durationMinutes: 465, goalDifferenceMinutes: -15, meetsGoal: false, alarm: false,
        canSave: true, canDelete: false, stepMinutes: 5
    )

    /// A night as the night view opens it.
    static let previewNight = SleepDraft(
        planId: nil, isNew: false, wakeDays: [], takenDays: [], bedMinutes: 1_380, wakeMinutes: 405,
        durationMinutes: 465, goalDifferenceMinutes: -15, meetsGoal: false, alarm: true, canSave: false,
        canDelete: false, stepMinutes: 5
    )

    /// A short night, well under the goal.
    static let previewShort = SleepDraft(
        planId: nil, isNew: false, wakeDays: [], takenDays: [], bedMinutes: 120, wakeMinutes: 360,
        durationMinutes: 240, goalDifferenceMinutes: -240, meetsGoal: false, alarm: true, canSave: true,
        canDelete: false, stepMinutes: 5
    )
}
