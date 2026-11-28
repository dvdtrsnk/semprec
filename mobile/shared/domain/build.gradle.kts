plugins { id("alldots.kmp") }
kotlin {
    sourceSets {
        commonMain.dependencies {
            api(project(":shared:core"))
            api(libs.coroutines.core)
            api(libs.kotlinx.datetime)
        }
        commonTest.dependencies { implementation(libs.coroutines.test) }
    }
}
