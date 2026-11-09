plugins {
    kotlin("jvm")
    `java-library`
    id("com.vanniktech.maven.publish")
}

// Bytecode for Java 17 so the same core runs on Android.
java {
    sourceCompatibility = JavaVersion.VERSION_17
    targetCompatibility = JavaVersion.VERSION_17
}

kotlin {
    compilerOptions {
        jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17)
    }
}

dependencies {
    testImplementation(kotlin("test"))
    testImplementation("org.junit.jupiter:junit-jupiter:5.11.3")
    testRuntimeOnly("org.junit.platform:junit-platform-launcher")
}

tasks.test {
    useJUnitPlatform()
    // Shared cross-language test vectors.
    systemProperty("testVectors", rootProject.file("../spec/test-vectors.json").absolutePath)
}

mavenPublishing {
    publishToMavenCentral(com.vanniktech.maven.publish.SonatypeHost.CENTRAL_PORTAL, automaticRelease = false)
    if (providers.gradleProperty("signingInMemoryKey").isPresent) signAllPublications()
    coordinates(artifactId = "basic-auth-core")
    pom {
        name.set("Intentgate basic-auth core")
        description.set("Check-in client for Intentgate: GPS position + passkey approval of server-issued events (JVM / Android).")
    }
}
