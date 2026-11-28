package cz.alldots.app.data

import java.time.LocalDate

internal actual fun localToday(): String = LocalDate.now().toString()
