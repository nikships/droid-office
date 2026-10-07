# kotlinx.serialization keeps what it needs through its own consumer rules; the app's
# @Serializable models live in these packages.
-keep,includedescriptorclasses class ai.factory.droidoffice.**$$serializer { *; }
-keepclassmembers class ai.factory.droidoffice.** {
    *** Companion;
}

# ML Kit finds its registrars through manifest meta-data and creates them by reflection.
# firebase-components only ships `-keep class * implements ComponentRegistrar`, and R8 full
# mode keeps the class without its constructor, so BarcodeScanning.getClient() gets no
# component and the scan screen crashes.
-keep class * implements com.google.firebase.components.ComponentRegistrar {
    <init>();
}
