import Foundation

/// The views of the sleep sheet: the overview, one night, and the three pickers of the overview.
public enum SleepPage: Equatable, Sendable {

    case main
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

/// The switches of the sleep overview.
public enum SleepSwitch: Equatable, Sendable {

    case enabled
    case showInCalendar
    case muteSemp
    case alarmSnooze
    case prepReminder
}

/// The part of the snake on the sleep dial that a finger holds: one end of the night, or the whole of it.
public enum SleepDialHandle: Equatable, Sendable {

    case bed
    case wake
    case whole
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

/// A schedule or a night while it is edited on the dial. `planId` is the plan being edited, nil for a new plan and
/// for a night; `wakeDays` are ISO weekdays and `takenDays` the weekdays other plans hold, which taking moves over.
/// Times are minutes after midnight; `durationMinutes` is the length of the night and `goalDifferenceMinutes` is
/// positive above the sleep goal and negative below it. `canSave` says whether the draft can be written and
/// `canDelete` whether its plan can be deleted. `stepMinutes` is the step the dial moves in.
public struct SleepDraft: Equatable, Sendable {

    public let planId: String?
    public let isNew: Bool
    public let wakeDays: [Int]
    public let takenDays: [Int]
    public let bedMinutes: Int
    public let wakeMinutes: Int
    public let durationMinutes: Int
    public let goalDifferenceMinutes: Int
    public let meetsGoal: Bool
    public let alarm: Bool
    public let canSave: Bool
    public let canDelete: Bool
    public let stepMinutes: Int

    public init(
        planId: String?,
        isNew: Bool,
        wakeDays: [Int],
        takenDays: [Int],
        bedMinutes: Int,
        wakeMinutes: Int,
        durationMinutes: Int,
        goalDifferenceMinutes: Int,
        meetsGoal: Bool,
        alarm: Bool,
        canSave: Bool,
        canDelete: Bool,
        stepMinutes: Int
    ) {
        self.planId = planId
        self.isNew = isNew
        self.wakeDays = wakeDays
        self.takenDays = takenDays
        self.bedMinutes = bedMinutes
        self.wakeMinutes = wakeMinutes
        self.durationMinutes = durationMinutes
        self.goalDifferenceMinutes = goalDifferenceMinutes
        self.meetsGoal = meetsGoal
        self.alarm = alarm
        self.canSave = canSave
        self.canDelete = canDelete
        self.stepMinutes = stepMinutes
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
    public var night: SleepNightItem?
    /// The plan being edited or added, nil while no editor is open; its sheet shows while this is set.
    public var editor: SleepDraft?
    /// The night on the night view.
    public var nightDraft: SleepDraft?
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
        night: SleepNightItem? = nil,
        editor: SleepDraft? = nil,
        nightDraft: SleepDraft? = nil,
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
        self.night = night
        self.editor = editor
        self.nightDraft = nightDraft
        self.saving = saving
        self.saveFailed = saveFailed
        self.saveFailure = saveFailure
    }
}

public enum SleepAction: Equatable, Sendable {

    case retry
    case open(SleepPage)
    case back
    case setSwitch(SleepSwitch, isOn: Bool)
    case pickMinutes(SleepMinutesChoice, minutes: Int)
    case pickSound(SleepAlarmSound)
    /// An action on the draft of a plan or a night.
    case draft(SleepDraftAction)
    case resetNight
    case dismissSaveFailure
}

/// What the person does to the draft of a plan or a night on the dial; the shared draft decides what each does.
public enum SleepDraftAction: Equatable, Sendable {

    /// Opens the editor on a plan, or on a new plan for nil.
    case editPlan(planID: String?)
    /// Moves a handle of the open draft to a time, minutes after midnight; the shared draft snaps and wraps it.
    case moveDial(SleepDialHandle, minutes: Int)
    /// An ISO weekday of the plan in the editor, 1 for Monday up to 7 for Sunday.
    case toggleDay(Int)
    case setAlarm(isOn: Bool)
    /// Writes the editor's draft as the plan it edits, or as a new plan under `newPlanName`, which the screen writes
    /// in the person's language.
    case confirm(newPlanName: String)
    case deletePlan
    case discard
    /// Writes the night's draft as the exception of the night the sheet is open for.
    case commitNight
}

/// The sleep sheet raises no effects: it closes itself.
public typealias SleepScreenModel = ScreenModel<SleepState, SleepAction, Never>

/// Sleep screen model for previews and tests; it never starts the Kotlin runtime.
public typealias ScriptedSleepScreenModel = ScriptedScreenModel<SleepState, SleepAction, Never>
