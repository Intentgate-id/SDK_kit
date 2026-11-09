// Android passkey bridge. Not part of the default build: needs the Android SDK
// and Google's Maven repository. Build with:
//   ./gradlew -PwithAndroid=true :android:assembleRelease
plugins {
    id("com.android.library")
    kotlin("android")
    id("com.vanniktech.maven.publish")
}

android {
    namespace = "id.intentgate.basicauth.android"
    compileSdk = 35
    defaultConfig {
        // Credential Manager passkeys need API 28+ (Google Play services); 34+ for the platform provider.
        minSdk = 28
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

kotlin {
    compilerOptions {
        jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17)
    }
}

dependencies {
    api(project(":core"))
    implementation("androidx.credentials:credentials:1.3.0")
    implementation("androidx.credentials:credentials-play-services-auth:1.3.0")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.9.0")
}

mavenPublishing {
    publishToMavenCentral(com.vanniktech.maven.publish.SonatypeHost.CENTRAL_PORTAL, automaticRelease = false)
    if (providers.gradleProperty("signingInMemoryKey").isPresent) signAllPublications()
    coordinates(artifactId = "basic-auth-android")
    pom {
        name.set("Intentgate basic-auth for Android")
        description.set("Passkey registration and check-in signing with Android Credential Manager for Intentgate basic-auth.")
    }
}
