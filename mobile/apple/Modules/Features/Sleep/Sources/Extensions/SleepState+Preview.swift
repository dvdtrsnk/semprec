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
            selectedPlanID: nil,
            night: SleepNightItem(
                night: "2026-10-16", planName: "Weekdays", bedMinutes: 1_380, wakeMinutes: 405, durationMinutes: 465,
                alarm: true, changed: false, reminderMinutes: 1_350
            ),
            ring: SleepRing(
                bedMinutes: 1_380, wakeMinutes: 405, durationMinutes: 465, goalDifferenceMinutes: -15, alarm: true
            ),
            canAddPlan: false,
            canDeletePlan: true
        )
    }

    /// The same sheet on another page; the plan page shows the first plan.
    func opening(_ page: SleepPage) -> SleepState {
        var state = self
        state.page = page
        state.isRoot = page == .main
        state.selectedPlanID = page == .plan ? plans.first?.id : nil
        state.takenDaysByOtherPlans = page == .plan ? [6, 7] : []
        return state
    }
}
