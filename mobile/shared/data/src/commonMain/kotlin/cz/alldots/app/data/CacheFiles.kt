package cz.alldots.app.data

/** The text of the file at [path], or `null` when there is none or it cannot be read as UTF-8. */
internal expect fun readCacheFile(path: String): String?

/**
 * Replaces the file at [path] with [text], creating its directory; the text is written beside it and moved over it, so
 * a reader finds the old file or the new one, never a part. `false` when that failed.
 */
internal expect fun writeCacheFile(path: String, text: String): Boolean

/** Deletes the file, or the directory with everything in it, at [path]; nothing there is no failure. */
internal expect fun deleteCachePath(path: String)

/** The names of the entries of the directory [path]; none when it does not exist. */
internal expect fun listCacheDirectory(path: String): List<String>

/** The bytes of the file at [path], or `null` when there is none or it cannot be read. */
internal expect fun readCacheBytes(path: String): ByteArray?

/**
 * Replaces the file at [path] with [bytes], creating its directory; the bytes are written beside it and moved over it,
 * so a reader finds the old file or the new one, never a part. `false` when that failed.
 */
internal expect fun writeCacheBytes(path: String, bytes: ByteArray): Boolean
