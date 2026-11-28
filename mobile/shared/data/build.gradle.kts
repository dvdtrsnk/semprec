import org.jetbrains.kotlin.gradle.ExperimentalKotlinGradlePluginApi

plugins {
    id("alldots.kmp")
    // Generates the serializers of the wire DTOs in this module.
    alias(libs.plugins.kotlin.serialization)
}
kotlin {
    // The JVM and Android targets share the java.net and javax.net.ssl socket of the IMAP client.
    @OptIn(ExperimentalKotlinGradlePluginApi::class)
    applyDefaultHierarchyTemplate {
        common {
            group("jvmAndAndroid") {
                withJvm()
                withAndroidTarget()
            }
        }
    }
    sourceSets {
        commonMain.dependencies {
            implementation(project(":shared:domain"))
            implementation(libs.ktor.client.core)
            implementation(libs.kotlinx.serialization.json)
        }
        androidMain.dependencies { implementation(libs.ktor.client.okhttp) }
        jvmMain.dependencies { implementation(libs.ktor.client.okhttp) }
        appleMain.dependencies { implementation(libs.ktor.client.darwin) }
        commonTest.dependencies {
            implementation(libs.coroutines.test)
            implementation(libs.ktor.client.mock)
        }
        // A real WebSocket server on the loopback interface, for the sync socket's tests on the JVM.
        jvmTest.dependencies {
            implementation(libs.ktor.server.cio)
            implementation(libs.ktor.server.websockets)
        }
    }
}
