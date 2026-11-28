package cz.alldots.app.data

import java.io.File
import java.io.IOException
import java.nio.file.Files
import java.nio.file.StandardCopyOption

internal actual fun readCacheFile(path: String): String? = try {
    File(path).takeIf(File::isFile)?.readText(Charsets.UTF_8)
} catch (_: IOException) {
    null
}

internal actual fun writeCacheFile(path: String, text: String): Boolean = try {
    val target = File(path)
    val directory = target.absoluteFile.parentFile
    directory.mkdirs()
    val written = File.createTempFile(target.name, ".tmp", directory)
    try {
        written.writeText(text, Charsets.UTF_8)
        Files.move(
            written.toPath(),
            target.toPath(),
            StandardCopyOption.REPLACE_EXISTING,
            StandardCopyOption.ATOMIC_MOVE,
        )
        true
    } finally {
        written.delete()
    }
} catch (_: IOException) {
    false
}

internal actual fun deleteCachePath(path: String) {
    File(path).deleteRecursively()
}

internal actual fun listCacheDirectory(path: String): List<String> = File(path).list()?.toList().orEmpty()
