val withAndroid = providers.gradleProperty("withAndroid").orNull == "true"

pluginManagement {
    repositories {
        if (providers.gradleProperty("withAndroid").orNull == "true") google()
        gradlePluginPortal()
        mavenCentral()
    }
}

dependencyResolutionManagement {
    repositories {
        if (providers.gradleProperty("withAndroid").orNull == "true") google()
        mavenCentral()
    }
}

rootProject.name = "intentgate-basic-auth"

// Pure JVM protocol + client logic. Builds and tests anywhere with a JDK.
include(":core")

// Android passkey bridge (Credential Manager). Needs the Android SDK and Google's Maven:
//   ./gradlew -PwithAndroid=true :android:assembleRelease
if (withAndroid) {
    include(":android")
}
