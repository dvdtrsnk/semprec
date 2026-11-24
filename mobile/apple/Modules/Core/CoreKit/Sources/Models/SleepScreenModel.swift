import Foundation

/// The views of the sleep sheet: the overview, one plan, one night, and the three pickers of the overview.
public enum SleepPage: Equatable, Sendable {

    case main
    case plan
    case night
    case remind
    case sound
    case goal
}

public enum SleepAlarmSound: CaseIterable, Equatable, Sendable {

    case morning
    case birds
    case piano
    case vibrateOnly
}

/// The switches of the sleep sheet; `alarm` belongs to the plan or the night that is open.
public enum SleepSwitch: Equatable, Sendable {

    case enabled
    case showInCalendar
    case muteSemp
    case alarmSnooze
    case prepReminder
    case alarm
}

public enum SleepTimeField: Equatable, Sendable {

    case bed
    case wake
}

public enum SleepMinutesChoice: Equatable, Sendable {

    case reminderLead
    case goal
}

/// One plan. Times are minutes after midnight; `wakeDays` are ISO weekdays, 1 for Monday up to 7 for Sunday.
public struct SleepPlanItem: Equatable, Identifiable, Sendable {

    public let id: String
    public let name: String
    public let wakeDays: [Int]
    public let bedMinutes: Int
    public let wakeMinutes: Int
    public let durationMinutes: Int
    public let alarm: Bool

    public init(
        id: String,
        name: String,
        wakeDays: [Int],
        bedMinutes: Int,
        wakeMinutes: Int,
        durationMinutes: Int,
        alarm: Bool
    ) {
        self.id = id
        self.name = name
        self.wakeDays = wakeDays
        self.bedMinutes = bedMinutes
        self.wakeMinutes = wakeMinutes
        self.durationMinutes = durationMinutes
        self.alarm = alarm
    }
}

/// One resolved night. `night` is the date of the evening, `YYYY-MM-DD`; `planName` is nil for a night that follows
/// no plan; `reminderMinutes` is the time of the preparation reminder, nil while the reminder is off.
public struct SleepNightItem: Equatable, Sendable {

    public let night: String
    public let planName: String?
    public let bedMinutes: Int
    public let wakeMinutes: Int
    public let durationMinutes: Int
    public let alarm: Bool
    public let changed: Bool
    public let reminderMinutes: Int?

    public init(
        night: String,
        planName: String?,
        bedMinutes: Int,
        wakeMinutes: Int,
        durationMinutes: Int,
        alarm: Bool,
        changed: Bool,
        reminderMinutes: Int?
    ) {
        self.night = night
        self.planName = planName
        self.bedMinutes = bedMinutes
        self.wakeMinutes = wakeMinutes
        self.durationMinutes = durationMinutes
        self.alarm = alarm
        self.changed = changed
        self.reminderMinutes = reminderMinutes
    }
}

/// What the ring draws. `goalDifferenceMinutes` is positive above the sleep goal and negative below it.
public struct SleepRing: Equatable, Sendable {

    public let bedMinutes: Int
    public let wakeMinutes: Int
    public let durationMinutes: Int
    public let goalDifferenceMinutes: Int
    public let alarm: Bool

    public init(bedMinutes: Int, wakeMinutes: Int, durationMinutes: Int, goalDifferenceMinutes: Int, alarm: Bool) {
        self.bedMinutes = bedMinutes
        self.wakeMinutes = wakeMinutes
        self.durationMinutes = durationMinutes
        self.goalDifferenceMinutes = goalDifferenceMinutes
        self.alarm = alarm
    }
}

public struct SleepState: Equatable, Sendable {

    public enum Phase: Equatable, Sendable {

        case loading
        case ready
        /// `nil` for an unexpected failure, which has no typed reason.
        case failure(FailureKind?)
    }

    public var phase: Phase
    public var page: SleepPage
    /// True on the view the sheet opens on: it closes the sheet instead of going back.
    public var isRoot: Bool
    public var enabled: Bool
    public var showInCalendar: Bool
    public var muteSemp: Bool
    public var alarmSound: SleepAlarmSound
    public var alarmSnooze: Bool
    public var goalMinutes: Int
    public var prepReminder: Bool
    public var prepReminderMinutes: Int
    public var goalOptions: [Int]
    public var reminderLeadOptions: [Int]
    public var plans: [SleepPlanItem]
    public var selectedPlanID: String?
    public var night: SleepNightItem?
    public var ring: SleepRing?
    public var takenDaysByOtherPlans: [Int]
    public var canAddPlan: Bool
    public var canDeletePlan: Bool
    public var saving: Bool
    /// Set after a write failed; `saveFailure` is its typed reason, nil for an unexpected one.
    public var saveFailed: Bool
    public var saveFailure: FailureKind?

    public init(
        phase: Phase = .loading,
        page: SleepPage = .main,
        isRoot: Bool = true,
        enabled: Bool = true,
        showInCalendar: Bool = true,
        muteSemp: Bool = true,
        alarmSound: SleepAlarmSound = .morning,
        alarmSnooze: Bool = true,
        goalMinutes: Int = 480,
        prepReminder: Bool = true,
        prepReminderMinutes: Int = 30,
        goalOptions: [Int] = [],
        reminderLeadOptions: [Int] = [],
        plans: [SleepPlanItem] = [],
        selectedPlanID: String? = nil,
        night: SleepNightItem? = nil,
        ring: SleepRing? = nil,
        takenDaysByOtherPlans: [Int] = [],
        canAddPlan: Bool = false,
        canDeletePlan: Bool = false,
        saving: Bool = false,
        saveFailed: Bool = false,
        saveFailure: FailureKind? = nil
    ) {
        self.phase = phase
        self.page = page
        self.isRoot = isRoot
        self.enabled = enabled
        self.showInCalendar = showInCalendar
        self.muteSemp = muteSemp
        self.alarmSound = alarmSound
        self.alarmSnooze = alarmSnooze
        self.goalMinutes = goalMinutes
        self.prepReminder = prepReminder
        self.prepReminderMinutes = prepReminderMinutes
        self.goalOptions = goalOptions
        self.reminderLeadOptions = reminderLeadOptions
        self.plans = plans
        self.selectedPlanID = selectedPlanID
        self.night = night
        self.ring = ring
        self.takenDaysByOtherPlans = takenDaysByOtherPlans
        self.canAddPlan = canAddPlan
        self.canDeletePlan = canDeletePlan
        self.saving = saving
        self.saveFailed = saveFailed
        self.saveFailure = saveFailure
    }
}

public enum SleepAction: Equatable, Sendable {

    case retry
    /// Goes to `page`; `planID` names the plan for `.plan` and is ignored by the other views.
    case open(SleepPage, planID: String?)
    case back
    case setSwitch(SleepSwitch, isOn: Bool)
    case pickMinutes(SleepMinutesChoice, minutes: Int)
    case pickSound(SleepAlarmSound)
    /// Minutes after midnight, for the plan or night that is open.
    case setTime(SleepTimeField, minutes: Int)
    /// An ISO weekday, 1 for Monday up to 7 for Sunday.
    case toggleDay(Int)
    /// Adds a plan for the free days under `name`, which the screen writes in the person's language.
    case addPlan(name: String)
    case deletePlan
    /// Writes one schedule from the schedule editor in one write: a new plan named `name` when `planID` is nil, else
    /// that plan. `wakeDays` are ISO weekdays; the days it takes leave the plans that held them.
    case savePlan(planID: String?, name: String, wakeDays: [Int], bedMinutes: Int, wakeMinutes: Int, alarm: Bool)
    /// Deletes the plan from the schedule editor, unless it is the last one.
    case removePlan(planID: String)
    /// Sets bedtime, wake time and the alarm of the shown night in one write.
    case saveNight(bedMinutes: Int, wakeMinutes: Int, alarm: Bool)
    case resetNight
    case dismissSaveFailure
}

/// The sleep sheet raises no effects: it closes itself.
public typealias SleepScreenModel = ScreenModel<SleepState, SleepAction, Never>

/// Sleep screen model for previews and tests; it never starts the Kotlin runtime.
public typealias ScriptedSleepScreenModel = ScriptedScreenModel<SleepState, SleepAction, Never>
