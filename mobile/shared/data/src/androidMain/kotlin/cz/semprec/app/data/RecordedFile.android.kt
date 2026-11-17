package cz.semprec.app.data

import java.io.File
import java.io.IOException

internal actual fun readRecordedFile(path: String): ByteArray? = try {
    File(path).readBytes()
} catch (_: IOException) {
    null
}
