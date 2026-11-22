package cz.semprec.app.data

import kotlinx.cinterop.BetaInteropApi
import kotlinx.cinterop.ExperimentalForeignApi
import platform.Foundation.NSFileManager
import platform.Foundation.NSString
import platform.Foundation.NSUTF8StringEncoding
import platform.Foundation.create
import platform.Foundation.stringWithContentsOfFile
import platform.Foundation.writeToFile

@OptIn(ExperimentalForeignApi::class)
internal actual fun readCacheFile(path: String): String? =
    NSString.stringWithContentsOfFile(path, NSUTF8StringEncoding, null)

@OptIn(ExperimentalForeignApi::class, BetaInteropApi::class)
internal actual fun writeCacheFile(path: String, text: String): Boolean {
    val directory = path.substringBeforeLast('/', "")
    if (directory.isNotEmpty()) {
        NSFileManager.defaultManager.createDirectoryAtPath(directory, withIntermediateDirectories = true, null, null)
    }
    return NSString.create(string = text).writeToFile(path, atomically = true, encoding = NSUTF8StringEncoding, null)
}

@OptIn(ExperimentalForeignApi::class)
internal actual fun deleteCachePath(path: String) {
    NSFileManager.defaultManager.removeItemAtPath(path, null)
}

@OptIn(ExperimentalForeignApi::class)
internal actual fun listCacheDirectory(path: String): List<String> =
    NSFileManager.defaultManager.contentsOfDirectoryAtPath(path, null)?.filterIsInstance<String>().orEmpty()
