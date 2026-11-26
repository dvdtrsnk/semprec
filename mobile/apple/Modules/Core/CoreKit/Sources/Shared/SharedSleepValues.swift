@preconcurrency internal import SharedSDK

// MARK: - Sleep views
extension SleepPage {

    init(_ page: SharedSDK.SleepScreen) {
        switch page {
        case .main: self = .main
        case .night: self = .night
        case .remind: self = .remind
        case .sound: self = .sound
        case .goal: self = .goal
        }
    }

    var shared: SharedSDK.SleepScreen {
        switch self {
        case .main: .main
        case .night: .night
        case .remind: .remind
        case .sound: .sound
        case .goal: .goal
        }
    }
}

// MARK: - Sleep sounds
extension SleepAlarmSound {

    init(_ sound: SharedSDK.SleepAlarmSound) {
        switch sound {
        case .morning: self = .morning
        case .birds: self = .birds
        case .piano: self = .piano
        case .vibrateOnly: self = .vibrateOnly
        }
    }

    var shared: SharedSDK.SleepAlarmSound {
        switch self {
        case .morning: .morning
        case .birds: .birds
        case .piano: .piano
        case .vibrateOnly: .vibrateOnly
        }
    }
}

// MARK: - Sleep switches
extension SleepSwitch {

    var shared: SharedSDK.SleepSwitch {
        switch self {
        case .enabled: .enabled
        case .showInCalendar: .showInCalendar
        case .muteSemp: .muteSemp
        case .alarmSnooze: .alarmSnooze
        case .prepReminder: .prepReminder
        }
    }
}

// MARK: - Sleep dial handles
extension SleepDialHandle {

    var shared: SharedSDK.SleepDialHandle {
        switch self {
        case .bed: .bed
        case .wake: .wake
        case .whole: .whole
        }
    }
}

// MARK: - Sleep minute choices
extension SleepMinutesChoice {

    var shared: SharedSDK.SleepMinutesChoice {
        switch self {
        case .reminderLead: .reminderLead
        case .goal: .goal
        }
    }
}

// MARK: - Sleep plans
extension SleepPlanItem {

    init(_ plan: SharedSDK.SleepPlanItem) {
        self.init(
            id: plan.id,
            name: plan.name,
            wakeDays: plan.wakeDays.map(\.intValue),
            bedMinutes: Int(plan.bedMinutes),
            wakeMinutes: Int(plan.wakeMinutes),
            durationMinutes: Int(plan.durationMinutes),
            alarm: plan.alarm
        )
    }
}

// MARK: - Sleep nights
extension SleepNightItem {

    init(_ night: SharedSDK.SleepNightItem) {
        self.init(
            night: night.night,
            planName: night.planName,
            bedMinutes: Int(night.bedMinutes),
            wakeMinutes: Int(night.wakeMinutes),
            durationMinutes: Int(night.durationMinutes),
            alarm: night.alarm,
            changed: night.changed,
            reminderMinutes: night.reminderMinutes.map(\.intValue)
        )
    }
}

// MARK: - Sleep drafts
extension SleepDraft {

    init(_ draft: SharedSDK.SleepDraft) {
        self.init(
            planId: draft.planId,
            isNew: draft.isNew,
            wakeDays: draft.wakeDays.map(\.intValue),
            takenDays: draft.takenDays.map(\.intValue),
            bedMinutes: Int(draft.bedMinutes),
            wakeMinutes: Int(draft.wakeMinutes),
            durationMinutes: Int(draft.durationMinutes),
            goalDifferenceMinutes: Int(draft.goalDifferenceMinutes),
            meetsGoal: draft.meetsGoal,
            alarm: draft.alarm,
            canSave: draft.canSave,
            canDelete: draft.canDelete,
            stepMinutes: Int(draft.stepMinutes)
        )
    }
}
