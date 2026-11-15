plugins { id("semprec.kmp") }
kotlin {
    sourceSets {
        commonMain.dependencies {
            api(project(":shared:core"))
            api(libs.coroutines.core)
        }
        commonTest.dependencies { implementation(libs.coroutines.test) }
    }
}
