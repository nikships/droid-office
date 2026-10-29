// Babel for Metro's React Native bundle only; Vite, tsc and tsx never read it.
module.exports = {
  presets: ['module:@react-native/babel-preset'],
  plugins: [
    ({ types }) => ({
      visitor: {
        RegExpLiteral(path, state) {
          // Marked combines regex .source strings. Renumbering a named backreference before that
          // composition breaks emphasis containing code. Hermes supports these constructor patterns.
          if (/[/\\]node_modules[/\\]marked[/\\]/.test(state.filename) && /\(\?<\w+>/.test(path.node.pattern)) {
            path.replaceWith(types.newExpression(types.identifier('RegExp'), [types.stringLiteral(path.node.pattern), types.stringLiteral(path.node.flags)]));
          }
        },
      },
    }),
  ],
};
