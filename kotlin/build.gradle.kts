// The Android Gradle plugin has to sit on the root classpath next to the Kotlin plugin,
// or Kotlin's Android support cannot see AGP's classes. Only loaded with -PwithAndroid=true,
// so the JVM-only build never needs Google's Maven repository.
buildscript {
    if (project.findProperty("withAndroid") == "true") {
        repositories {
            google()
            mavenCentral()
        }
        dependencies {
            classpath("com.android.tools.build:gradle:8.7.3")
        }
    }
}

plugins {
    kotlin("jvm") version "2.0.21" apply false
    // Publishing to Maven Central (Central Portal) with signing. Coordinates and POM data
    // are in gradle.properties; credentials come from the release workflow's secrets.
    id("com.vanniktech.maven.publish") version "0.30.0" apply false
}
