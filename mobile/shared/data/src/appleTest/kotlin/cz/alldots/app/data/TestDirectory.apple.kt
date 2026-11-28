package cz.alldots.app.data

import platform.Foundation.NSTemporaryDirectory
import platform.Foundation.NSUUID

internal actual fun newTestDirectory(): String =
    "${NSTemporaryDirectory().trimEnd('/')}/alldots-cache-test-${NSUUID().UUIDString()}"
