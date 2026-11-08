import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
    // Generates the serializers of the app's type-safe navigation routes.
    id("org.jetbrains.kotlin.plugin.serialization")
}

// No JVM toolchain: the build runs on the JDK that runs Gradle (17 to 23, see scripts/verify) and emits
// Java 17 bytecode.
kotlin { compilerOptions.jvmTarget.set(JvmTarget.JVM_17) }

android {
    namespace = configurationValue("namespace")
    configureAndroid(this)
    defaultConfig {
        applicationId = configurationValue("androidApplicationId")
        targetSdk = configurationValue("androidTargetSdk").toInt()
        versionCode = configurationValue("versionCode").toInt()
        versionName = configurationValue("versionName")
    }
    buildFeatures.compose = true
}

addComposePreviewTooling()
