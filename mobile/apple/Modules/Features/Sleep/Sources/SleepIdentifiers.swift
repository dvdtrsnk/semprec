/// Accessibility identifiers of the Sleep feature's elements. Android has no sleep screens yet, so none is shared.
enum SleepIdentifiers {

    static let screen = "sleep.screen"
    static let close = "sleep.closeButton"
    static let done = "sleep.doneButton"
    static let back = "sleep.backButton"
    static let enabled = "sleep.enabled"
    /// Followed by the plan id, e.g. `sleep.plan.3f2a`.
    static let planPrefix = "sleep.plan."
    static let addPlan = "sleep.addPlan"
    static let deletePlan = "sleep.deletePlan"
    /// Followed by the ISO weekday, 1 for Monday up to 7 for Sunday.
    static let dayPrefix = "sleep.day."
    static let alarm = "sleep.alarm"
    static let resetNight = "sleep.resetNight"
    static let openPlans = "sleep.openPlans"
    static let prepReminder = "sleep.prepReminder"
    static let reminderLead = "sleep.reminderLead"
    static let muteSemp = "sleep.muteSemp"
    static let sound = "sleep.sound"
    static let snooze = "sleep.snooze"
    static let showInCalendar = "sleep.showInCalendar"
    static let goal = "sleep.goal"
    /// Followed by the picked value, e.g. `sleep.option.450` or `sleep.option.piano`.
    static let optionPrefix = "sleep.option."
    static let dial = "sleep.dial"
    static let nightTimes = "sleep.night.times"
    static let editor = "sleep.editor"
    static let editorClose = "sleep.editor.close"
    static let editorConfirm = "sleep.editor.confirm"
}
