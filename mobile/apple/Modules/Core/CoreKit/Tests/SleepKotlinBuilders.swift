import SharedSDK

@testable import CoreKit

/// Kotlin sleep values for the bridge tests, and the Swift values they must map to. Both modules declare these type
/// names, so each is qualified with its module.
enum SleepKotlin {

    /// What a Kotlin sleep state holds besides its phase, view and failures.
    struct Parts {

        var plans: [SharedSDK.SleepPlanItem] = []
        var night: SharedSDK.SleepNightItem?
        var editor: SharedSDK.SleepDraft?
        var nightDraft: SharedSDK.SleepDraft?
    }

    static func plan() -> SharedSDK.SleepPlanItem {
        SharedSDK.SleepPlanItem(
            id: "p1", name: "Weekdays", wakeDays: [1, 2, 3], bedMinutes: 1380, wakeMinutes: 405,
            durationMinutes: 465, alarm: true
        )
    }

    static func night(reminder: Int32?) -> SharedSDK.SleepNightItem {
        SharedSDK.SleepNightItem(
            night: "2026-10-16", planName: "Weekdays", bedMinutes: 1380, wakeMinutes: 405,
            durationMinutes: 465, alarm: true, changed: false, reminderMinutes: reminder.map { KotlinInt(int: $0) }
        )
    }

    static func draft(planId: String?, isNew: Bool) -> SharedSDK.SleepDraft {
        SharedSDK.SleepDraft(
            planId: planId, isNew: isNew, wakeDays: [1, 2, 3], takenDays: [6, 7], bedMinutes: 1380, wakeMinutes: 405,
            durationMinutes: 465, goalDifferenceMinutes: -15, meetsGoal: false, alarm: true, canSave: true,
            canDelete: true, stepMinutes: 5
        )
    }

    /// The Swift draft that `draft(planId:isNew:)` maps to.
    static func mappedDraft(planId: String?, isNew: Bool) -> CoreKit.SleepDraft {
        CoreKit.SleepDraft(
            planId: planId, isNew: isNew, wakeDays: [1, 2, 3], takenDays: [6, 7], bedMinutes: 1380, wakeMinutes: 405,
            durationMinutes: 465, goalDifferenceMinutes: -15, meetsGoal: false, alarm: true, canSave: true,
            canDelete: true, stepMinutes: 5
        )
    }

    static func state(
        phase: SharedSDK.SleepPhase,
        screen: SharedSDK.SleepScreen,
        failure: SharedSDK.FailureKind? = nil,
        saveFailure: SharedSDK.FailureKind? = .rejected,
        parts: Parts = Parts()
    ) -> SharedSDK.SleepState {
        SharedSDK.SleepState(
            phase: phase,
            failure: failure,
            screen: screen,
            isRoot: true,
            enabled: true,
            showInCalendar: false,
            muteSemp: true,
            alarmSound: .piano,
            alarmSnooze: true,
            goalMinutes: 480,
            prepReminder: true,
            prepReminderMinutes: 30,
            goalOptions: [450, 480],
            reminderLeadOptions: [30, 45],
            plans: parts.plans,
            night: parts.night,
            editor: parts.editor,
            nightDraft: parts.nightDraft,
            saving: true,
            saveFailed: true,
            saveFailure: saveFailure
        )
    }
}
