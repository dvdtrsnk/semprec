package cz.semprec.app.data

import kotlinx.cinterop.BetaInteropApi
import kotlinx.cinterop.ExperimentalForeignApi
import kotlinx.cinterop.addressOf
import kotlinx.cinterop.usePinned
import platform.Foundation.NSData
import platform.Foundation.NSFileManager
import platform.Foundation.NSString
import platform.Foundation.NSUTF8StringEncoding
import platform.Foundation.create
import platform.Foundation.dataWithContentsOfFile
import platform.Foundation.stringWithContentsOfFile
import platform.Foundation.writeToFile
import platform.posix.memcpy

@OptIn(ExperimentalForeignApi::class)
internal actual fun readCacheFile(path: String): String? =
    NSString.stringWithContentsOfFile(path, NSUTF8StringEncoding, null)

@OptIn(ExperimentalForeignApi::class, BetaInteropApi::class)
internal actual fun writeCacheFile(path: String, text: String): Boolean {
    createParentDirectory(path)
    return NSString.create(string = text).writeToFile(path, atomically = true, encoding = NSUTF8StringEncoding, null)
}

@OptIn(ExperimentalForeignApi::class)
internal actual fun readCacheBytes(path: String): ByteArray? {
    val data = NSData.dataWithContentsOfFile(path) ?: return null
    val bytes = ByteArray(data.length.toInt())
    if (bytes.isNotEmpty()) bytes.usePinned { pinned -> memcpy(pinned.addressOf(0), data.bytes, data.length) }
    return bytes
}

@OptIn(ExperimentalForeignApi::class, BetaInteropApi::class)
internal actual fun writeCacheBytes(path: String, bytes: ByteArray): Boolean {
    createParentDirectory(path)
    val data = if (bytes.isEmpty()) {
        NSData()
    } else {
        bytes.usePinned { pinned -> NSData.create(bytes = pinned.addressOf(0), length = bytes.size.toULong()) }
    }
    return data.writeToFile(path, atomically = true)
}

@OptIn(ExperimentalForeignApi::class)
private fun createParentDirectory(path: String) {
    val directory = path.substringBeforeLast('/', "")
    if (directory.isNotEmpty()) {
        NSFileManager.defaultManager.createDirectoryAtPath(directory, withIntermediateDirectories = true, null, null)
    }
}

@OptIn(ExperimentalForeignApi::class)
internal actual fun deleteCachePath(path: String) {
    NSFileManager.defaultManager.removeItemAtPath(path, null)
}

@OptIn(ExperimentalForeignApi::class)
internal actual fun listCacheDirectory(path: String): List<String> =
    NSFileManager.defaultManager.contentsOfDirectoryAtPath(path, null)?.filterIsInstance<String>().orEmpty()
