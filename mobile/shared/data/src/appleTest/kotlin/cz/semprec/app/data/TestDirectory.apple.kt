package cz.semprec.app.data

import platform.Foundation.NSTemporaryDirectory
import platform.Foundation.NSUUID

internal actual fun newTestDirectory(): String =
    "${NSTemporaryDirectory().trimEnd('/')}/semprec-cache-test-${NSUUID().UUIDString()}"
