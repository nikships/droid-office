// What the React Native CLI and the Android Gradle autolinking read. The companion links no
// third-party native libraries: its native code is the app's own (android/app).
module.exports = {
  project: {
    android: { sourceDir: './android', appName: 'app', packageName: 'ai.factory.droidoffice' },
  },
  dependencies: {},
};
