import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    id("com.android.library")
    id("org.jetbrains.kotlin.android")
}

// No JVM toolchain: the build runs on the JDK that runs Gradle (17 to 23, see scripts/verify) and emits
// Java 17 bytecode.
kotlin { compilerOptions.jvmTarget.set(JvmTarget.JVM_17) }

android {
    namespace = moduleNamespace()
    configureAndroid(this)
}
