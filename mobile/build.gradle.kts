import io.gitlab.arturbosch.detekt.Detekt

plugins {
    base
    alias(libs.plugins.kotlin.multiplatform) apply false
    alias(libs.plugins.kotlin.android) apply false
    alias(libs.plugins.android.application) apply false
    alias(libs.plugins.android.library) apply false
    alias(libs.plugins.compose.compiler) apply false
    alias(libs.plugins.skie) apply false
    alias(libs.plugins.detekt)
}

/** Paths of the modules (projects with a build script) below [parent], e.g. `:shared:core` below `:shared`. */
fun modulesBelow(parent: String): List<String> =
    subprojects.filter { it.path.startsWith("$parent:") && it.buildFile.isFile }.map { it.path }

val sharedModules = modulesBelow(":shared")
val androidModules = modulesBelow(":android")

tasks.register("sharedJvmTest") {
    group = "verification"
    description = "Runs the tests of every shared module on the JVM."
    dependsOn(sharedModules.map { "$it:jvmTest" })
}

val iosSimulatorId = providers.gradleProperty("mobile.iosSimulatorId")
val appleSiliconHost = providers.systemProperty("os.name").get().startsWith("Mac") &&
    providers.systemProperty("os.arch").get() == "aarch64"
tasks.register("sharedAppleTest") {
    group = "verification"
    description = "Runs the tests of every shared module natively on macOS, and on the iOS simulator whose UDID " +
        "-Pmobile.iosSimulatorId passes in."
    dependsOn(sharedModules.map { "$it:macosArm64Test" })
    if (iosSimulatorId.isPresent) dependsOn(sharedModules.map { "$it:iosSimulatorArm64Test" })
    // On hosts that cannot run these tests Kotlin/Native skips them instead of failing, leaving nothing tested.
    doLast { if (!appleSiliconHost) throw GradleException("sharedAppleTest needs an Apple silicon Mac with Xcode.") }
}

tasks.register("androidUnitTest") {
    group = "verification"
    description = "Runs the JVM unit tests of every Android module (debug variant)."
    dependsOn(androidModules.map { "$it:testDebugUnitTest" })
}

tasks.register<Detekt>("detektAll") {
    // Developers format in place by default; `-PdetektAutoFix=false` is read-only analysis for CI and scripts.
    val autoFix = providers.gradleProperty("detektAutoFix").map(String::toBoolean).getOrElse(true)

    description = "Runs detekt with the formatting and Compose rules over every Android, shared and build-logic " +
        "Kotlin source."
    group = "verification"
    parallel = true
    ignoreFailures = false
    autoCorrect = autoFix
    buildUponDefaultConfig = true
    setSource(files("android", "shared", "build-logic/src"))
    config.setFrom(files("config/detekt/detekt.yml"))
    include("**/*.kt")
    exclude("**/build/**")
    reports {
        html.required.set(true)
        xml.required.set(true)
        xml.outputLocation.set(layout.buildDirectory.file("reports/detekt/detekt.xml"))
        txt.required.set(true)
    }
}

dependencies {
    detektPlugins(libs.detekt.formatting)
    detektPlugins(libs.detekt.compose)
}
