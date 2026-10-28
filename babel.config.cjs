// Babel for Metro's React Native bundle only; Vite, tsc and tsx never read it.
module.exports = {
  presets: ['module:@react-native/babel-preset'],
};
