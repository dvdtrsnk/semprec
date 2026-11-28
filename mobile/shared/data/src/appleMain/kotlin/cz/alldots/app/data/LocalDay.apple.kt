package cz.alldots.app.data

import platform.Foundation.NSCalendar
import platform.Foundation.NSCalendarIdentifierGregorian
import platform.Foundation.NSDate
import platform.Foundation.NSDateFormatter
import platform.Foundation.NSLocale
import platform.Foundation.NSTimeZone
import platform.Foundation.localTimeZone

internal actual fun localToday(): String {
    val formatter = NSDateFormatter()
    formatter.locale = NSLocale(localeIdentifier = "en_US_POSIX")
    formatter.calendar = NSCalendar(calendarIdentifier = NSCalendarIdentifierGregorian)
    formatter.timeZone = NSTimeZone.localTimeZone
    formatter.dateFormat = "yyyy-MM-dd"
    return formatter.stringFromDate(NSDate())
}
