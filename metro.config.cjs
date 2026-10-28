// Metro bundles the React Native companion (index.mobile.js, src/mobile/) for android/. The root
// package is ESM, so every config React Native reads from here is CommonJS (.cjs).
const path = require('node:path');
const { getDefaultConfig, mergeConfig } = require('@react-native/metro-config');

const root = __dirname;
const skip = ['android', 'dist', 'release', 'website', 'native', 'build', 'docs', 'deploy', '.droid-office', 'src/client/public', 'src/server', 'src/desktop'].map((dir) => path.join(root, dir));
const literal = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

module.exports = mergeConfig(getDefaultConfig(root), {
  projectRoot: root,
  watchFolders: [root],
  resolver: {
    blockList: skip.map((dir) => new RegExp(`^${literal(dir)}(/.*)?$`)),
    // src/shared is also compiled by the server (NodeNext), so its relative imports name the .js it
    // becomes; here they resolve to the .ts source beside it.
    resolveRequest(context, name, platform) {
      if (name.startsWith('.') && name.endsWith('.js')) {
        try {
          return context.resolveRequest(context, `${name.slice(0, -3)}.ts`, platform);
        } catch {
          // Not TypeScript: an actual .js file.
        }
      }
      return context.resolveRequest(context, name, platform);
    },
  },
});
