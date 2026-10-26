plugins {
    id("semprec.kmp")
    alias(libs.plugins.skie)
}
kotlin {
    val frameworkName = configurationValue("frameworkName")
    listOf(iosArm64(), iosSimulatorArm64(), macosArm64()).forEach { target ->
        target.binaries.framework {
            baseName = frameworkName
            isStatic = false
            export(project(":shared:presentation"))
            export(project(":shared:core"))
            binaryOption("bundleId", "${configurationValue("appleBundleId")}.$frameworkName")
        }
    }
    sourceSets {
        commonMain.dependencies {
            implementation(project(":shared:domain"))
            implementation(project(":shared:data"))
            api(project(":shared:presentation"))
            api(project(":shared:core"))
        }
        commonTest.dependencies { implementation(libs.coroutines.test) }
    }
}
skie { analytics.enabled.set(false) }
