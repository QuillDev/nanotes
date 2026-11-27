plugins {
    alias(libs.plugins.android.application)
}

// The app's version is the repo's package.json version. The version code keeps the scheme the
// earlier Android app used (major * 1000000 + minor * 1000 + patch: 0.3.14 is 3014), so every
// release installs over the one before it.
val appVersion = Regex(""""version"\s*:\s*"(\d+)\.(\d+)\.(\d+)"""")
    .find(rootProject.file("../package.json").readText())
    ?.destructured
    ?: error("package.json has no x.y.z version")
val (major, minor, patch) = appVersion
val keystorePath = providers.environmentVariable("NANOTES_ANDROID_KEYSTORE").orNull

android {
    namespace = "moe.quill.nanotes"
    compileSdk = 37

    defaultConfig {
        applicationId = "moe.quill.nanotes"
        minSdk = 24
        targetSdk = 37
        versionCode = major.toInt() * 1_000_000 + minor.toInt() * 1_000 + patch.toInt()
        versionName = "$major.$minor.$patch"
    }

    // Release APKs are signed with the same key as every earlier release, so installs update in place.
    signingConfigs {
        if (keystorePath != null) {
            create("release") {
                storeFile = file(keystorePath)
                storePassword = providers.environmentVariable("NANOTES_ANDROID_KEYSTORE_PASSWORD").get()
                keyAlias = "nanotes"
                keyPassword = providers.environmentVariable("NANOTES_ANDROID_KEYSTORE_PASSWORD").get()
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            signingConfig = signingConfigs.findByName("release")
        }
        debug {
            applicationIdSuffix = ".debug"
        }
    }

    buildFeatures {
        buildConfig = true
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

kotlin {
    jvmToolchain(21)
}

dependencies {
    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.activity)
    implementation(libs.androidx.webkit)
    implementation(libs.androidx.browser)

    testImplementation(libs.junit)
}
