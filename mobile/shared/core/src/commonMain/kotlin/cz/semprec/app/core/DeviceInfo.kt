package cz.semprec.app.core

/** The kind of native app a session belongs to; the wire value is [wireName] (`ios`, `macos`). */
enum class AppPlatform(val wireName: String) { IOS("ios"), MACOS("macos") }

/**
 * What a login records about this device, so the person can recognise and revoke it later. [deviceKind] is the
 * wire value the server accepts for the platform: `iphone` or `ipad` on iOS, `mac` on macOS.
 */
data class DeviceInfo(
    val platform: AppPlatform,
    val deviceId: String,
    val deviceName: String,
    val deviceKind: String,
    val osVersion: String,
    val appVersion: String,
)
