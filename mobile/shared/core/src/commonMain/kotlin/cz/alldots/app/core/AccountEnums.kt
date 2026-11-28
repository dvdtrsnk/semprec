package cz.alldots.app.core

/** The platform a signed-in device runs on, as the server records it. */
enum class AccountPlatform { WEB, IOS, MACOS, UNKNOWN }

/** What kind of device a session belongs to; [UNKNOWN] when the server recorded none. */
enum class AccountDeviceKind { IPHONE, IPAD, MAC, BROWSER, UNKNOWN }

/** How much of what goes wrong with Semp is pushed to the person. */
enum class AccountProblemsLevel { OFF, CRITICAL, ALL }

/** The switches of the notification settings a person changes one at a time. */
enum class AccountNotificationSwitch {
    APPROVALS,
    INVITES,
    REMINDERS,
    CALENDAR_CHANGES,
    PROBLEMS_SUMMARY,
    BADGE_APPROVALS,
    BADGE_INVITES,
    BADGE_INBOX,
}

/** How a usage report is cut: one point per day, or one per month for the whole life of the account. */
enum class AccountUsageGranularity { DAY, MONTH }

/** What the server did with one id of a restore from the trash. */
enum class AccountRestoreStatus { RESTORED, NOT_FOUND, DATABASE_ARCHIVED, CONFLICT }
