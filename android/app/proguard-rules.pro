# kotlinx.serialization keeps what it needs through its own consumer rules; the app's
# @Serializable models live in these packages.
-keep,includedescriptorclasses class ai.factory.droidoffice.**$$serializer { *; }
-keepclassmembers class ai.factory.droidoffice.** {
    *** Companion;
}
