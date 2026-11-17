import org.jetbrains.kotlin.gradle.dsl.JvmTarget
import org.jetbrains.kotlin.gradle.plugin.mpp.KotlinNativeTarget
import org.jetbrains.kotlin.gradle.targets.native.tasks.KotlinNativeSimulatorTest

plugins {
    id("org.jetbrains.kotlin.multiplatform")
    id("com.android.library")
}

// No JVM toolchain: the build runs on the JDK that runs Gradle (17 to 23, see scripts/verify) and emits
// Java 17 bytecode.
kotlin {
    jvm { compilerOptions.jvmTarget.set(JvmTarget.JVM_17) }
    androidTarget { compilerOptions.jvmTarget.set(JvmTarget.JVM_17) }
    val iosMinimum = configurationValue("iosMinimum")
    listOf(iosArm64(), iosSimulatorArm64()).forEach { it.overrideMinimumOsVersion(iosMinimum) }
    macosArm64().overrideMinimumOsVersion(configurationValue("macosMinimum"))
    sourceSets.commonTest.dependencies { implementation(kotlin("test")) }
}

android {
    namespace = moduleNamespace()
    configureAndroid(this)
}

// By default Kotlin/Native boots a simulator of its own choice for iosSimulatorArm64Test and shuts it down
// afterwards. Here the tests run only on the already booted simulator whose UDID the caller passes in, and the
// build never changes that simulator's state.
val iosSimulatorId = providers.gradleProperty("mobile.iosSimulatorId")
tasks.withType<KotlinNativeSimulatorTest>().configureEach {
    standalone.set(false)
    if (iosSimulatorId.isPresent) device.set(iosSimulatorId)
}
gradle.taskGraph.whenReady {
    val requested = allTasks.filter { it is KotlinNativeSimulatorTest && it.project == project }
    if (requested.isNotEmpty() && !iosSimulatorId.isPresent) {
        throw GradleException(
            "${requested.joinToString { it.path }} runs on a booted iOS simulator that you own. Pass its UDID with " +
                "-Pmobile.iosSimulatorId=<UDID>; the build never picks, boots or shuts down a simulator itself.",
        )
    }
}

/** Builds klibs and binaries for the app's minimum OS version instead of the Kotlin/Native default. */
fun KotlinNativeTarget.overrideMinimumOsVersion(version: String) {
    val argument = "-Xoverride-konan-properties=osVersionMin.${konanTarget.name}=$version"
    compilerOptions.freeCompilerArgs.add(argument)
    binaries.configureEach { freeCompilerArgs += argument }
}
