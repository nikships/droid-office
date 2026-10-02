# Network probe dependencies

The SHA-256-pinned JARs in `network-deps.json` come from Maven Central. Run
`node native/unity-spike/Tools/fetch-network.mjs` to verify or restore them.
No Gradle/Maven dependency ranges are used.

- OkHttp JVM 5.3.2, Square, Apache-2.0.
- Okio JVM 3.16.4, Square, Apache-2.0.
- Kotlin stdlib 2.2.21, JetBrains, Apache-2.0.
- JetBrains annotations 13.0, Apache-2.0.

The libraries carry their upstream license notices in their JARs. Kotlin
2.2.21 satisfies Okio's 2.2.20 dependency. OkHttp's JVM artifact, not its
multiplatform metadata-only artifact, is required for Java/Android.

These dependencies belong to the isolated spike. U1 must revalidate Android
JNI throughput and stripping before treating the transport as production-ready.
