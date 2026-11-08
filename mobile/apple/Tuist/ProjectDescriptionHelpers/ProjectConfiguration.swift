/// Identity, version, minimum OS versions and architectures of the Apple app. The identity, version and minimum
/// values are also in mobile/gradle/project.properties (appleBundleId, frameworkName, versionName, versionCode,
/// iosMinimum, macosMinimum), which the Kotlin framework is built from; both files must agree.
public enum ProjectConfiguration {
    /// Product, scheme, workspace and display name of the app.
    public static let appName = "Semprec"
    public static let appleBundleId = "cz.semprec.app"
    public static let frameworkName = "SharedSDK"
    public static let versionName = "0.1.0"
    public static let versionCode = "1"
    public static let iosMinimum = "26.0"
    public static let macosMinimum = "26.0"
    /// `ARCHS` of every Tuist project and of the Swift packages. It must match the slices of the Kotlin framework:
    /// the Kotlin Apple targets of mobile/shared/umbrella/build.gradle.kts (iosArm64, iosSimulatorArm64,
    /// macosArm64) and the architecture check in mobile/scripts/kmp-framework, which rejects any other value.
    public static let architectures = "arm64"
}
