plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.compose)
    alias(libs.plugins.ksp)
}

android {
    namespace = "app.scrollantir"
    compileSdk {
        version = release(36) {
            minorApiLevel = 1
        }
    }

    defaultConfig {
        applicationId = "app.scrollantir"
        minSdk = 24
        targetSdk = 36
        versionCode = 1
        versionName = "1.0"

        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"

        buildConfigField("long", "BUILD_TIME_MS", "${System.currentTimeMillis()}L")
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro"
            )
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_11
        targetCompatibility = JavaVersion.VERSION_11
    }
    buildFeatures {
        compose = true
        buildConfig = true
    }

    // Android 15 Enhanced Confirmation Mode treats any app whose installer
    // isn't Play Store as "sideloaded" and silently blocks accessibility
    // event delivery. Passing -i com.android.vending to adb sets the
    // installer-record to Play Store, which satisfies the check. This makes
    // Android Studio's Run button also use the flag (otherwise only our
    // installDebugSpoofed Gradle task would).
    installation {
        installOptions.addAll(listOf("-r", "-i", "com.android.vending"))
    }
}

// --- Android 15 workaround ---
// Sideloaded apps (installed via plain `adb install` / Android Studio Run)
// are blocked from actually binding accessibility services on Android 15+
// by Enhanced Confirmation Mode. Installing with -i com.android.vending
// spoofs "installed from Play Store" and satisfies the check.
//
// Run after each new build:
//   ./gradlew :app:installDebugSpoofed
tasks.register<Exec>("installDebugSpoofed") {
    group = "install"
    description = "adb install with -i com.android.vending (bypasses Android 15 Enhanced Confirmation for accessibility)"
    dependsOn("assembleDebug")

    val adbPath = System.getenv("ANDROID_HOME")?.let { "$it/platform-tools/adb" }
        ?: "${System.getProperty("user.home")}/Library/Android/sdk/platform-tools/adb"
    val apkPath = layout.buildDirectory
        .file("outputs/apk/debug/app-debug.apk")
        .get().asFile.absolutePath

    commandLine(adbPath, "install", "-r", "-i", "com.android.vending", apkPath)
}

dependencies {
    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.lifecycle.runtime.ktx)
    implementation(libs.androidx.lifecycle.runtime.compose)
    implementation(libs.androidx.activity.compose)
    implementation(platform(libs.androidx.compose.bom))
    implementation(libs.androidx.compose.ui)
    implementation(libs.androidx.compose.ui.graphics)
    implementation(libs.androidx.compose.ui.tooling.preview)
    implementation(libs.androidx.compose.material3)
    implementation(libs.androidx.compose.material.icons.core)
    implementation(libs.androidx.compose.material.icons.extended)
    implementation(libs.kotlinx.coroutines.android)
    implementation(libs.androidx.room.runtime)
    implementation(libs.androidx.room.ktx)
    ksp(libs.androidx.room.compiler)
    implementation(libs.androidx.work.runtime.ktx)
    implementation(libs.androidx.security.crypto)
    implementation(libs.okhttp)
    implementation(libs.telephoto.zoomable)
    testImplementation(libs.junit)
    androidTestImplementation(libs.androidx.junit)
    androidTestImplementation(libs.androidx.espresso.core)
    androidTestImplementation(platform(libs.androidx.compose.bom))
    androidTestImplementation(libs.androidx.compose.ui.test.junit4)
    debugImplementation(libs.androidx.compose.ui.tooling)
    debugImplementation(libs.androidx.compose.ui.test.manifest)
}