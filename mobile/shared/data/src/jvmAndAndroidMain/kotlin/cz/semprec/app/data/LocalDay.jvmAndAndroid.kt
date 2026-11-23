package cz.semprec.app.data

import java.time.LocalDate

internal actual fun localToday(): String = LocalDate.now().toString()
