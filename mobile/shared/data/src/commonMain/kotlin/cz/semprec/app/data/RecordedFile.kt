package cz.semprec.app.data

/** The bytes of the file at [path], or `null` when it cannot be read. A recording is read whole to be uploaded. */
internal expect fun readRecordedFile(path: String): ByteArray?
