import { memo, useMemo } from 'react';
import { Alert, Linking, ScrollView, Text, type TextStyle, View } from 'react-native';
import { type MdBlock, type MdSpan, parseMarkdown } from '../markdown';
import { colors, s } from './kit';

/** Asks before leaving the app: a reply's link text can say anything. */
function openLink(href: string) {
  Alert.alert('Open link?', href, [
    { text: 'Cancel', style: 'cancel' },
    { text: 'Open', onPress: () => void Linking.openURL(href).catch(() => Alert.alert('Could not open that link.')) },
  ]);
}

function Spans({ spans, style }: { spans: readonly MdSpan[]; style?: TextStyle }) {
  return (
    <Text selectable style={[s.text, style]}>
      {spans.map((x, i) => (
        <Text
          key={i}
          style={[x.bold && { fontWeight: '600' }, x.italic && { fontStyle: 'italic' }, x.strike && { textDecorationLine: 'line-through' }, x.code && s.code, x.href ? { color: colors.accent, textDecorationLine: 'underline' } : null]}
          onPress={x.href ? () => openLink(x.href as string) : undefined}
          accessibilityRole={x.href ? 'link' : undefined}
        >
          {x.text}
        </Text>
      ))}
    </Text>
  );
}

const HEADING: Record<number, TextStyle> = { 1: { fontSize: 20, fontWeight: '600' }, 2: { fontSize: 18, fontWeight: '600' }, 3: { fontSize: 16, fontWeight: '600' } };

function Block({ block }: { block: MdBlock }) {
  switch (block.kind) {
    case 'paragraph':
      return <Spans spans={block.spans} />;
    case 'heading':
      return <Spans spans={block.spans} style={HEADING[block.depth] ?? { fontWeight: '600' }} />;
    case 'code':
      return (
        <View style={{ backgroundColor: colors.raised, borderRadius: 4, padding: 8 }}>
          {block.lang ? <Text style={[s.muted, { fontSize: 11 }]}>{block.lang}</Text> : null}
          <ScrollView horizontal>
            <Text selectable style={s.code}>
              {block.text}
            </Text>
          </ScrollView>
        </View>
      );
    case 'list':
      return (
        <View style={{ gap: 2 }}>
          {block.items.map((item, i) => (
            <View key={i} style={{ flexDirection: 'row', gap: 6 }}>
              <Text style={[s.text, { minWidth: 18, textAlign: 'right' }]}>{item.checked !== undefined ? (item.checked ? '☑' : '☐') : block.ordered ? `${block.start + i}.` : '•'}</Text>
              <View style={{ flex: 1, gap: 4 }}>
                <Blocks blocks={item.blocks} />
              </View>
            </View>
          ))}
        </View>
      );
    case 'quote':
      return (
        <View style={{ borderLeftWidth: 3, borderColor: colors.border, paddingLeft: 8, gap: 4 }}>
          <Blocks blocks={block.blocks} />
        </View>
      );
    case 'table':
      return (
        <ScrollView horizontal>
          <View style={{ borderWidth: 1, borderColor: colors.border, borderRadius: 4 }}>
            {[block.header, ...block.rows].map((row, r) => (
              <View key={r} style={{ flexDirection: 'row', borderTopWidth: r ? 1 : 0, borderColor: colors.border, backgroundColor: r ? undefined : colors.raised }}>
                {row.map((cell, c) => (
                  <View key={c} style={{ width: 140, padding: 6, borderLeftWidth: c ? 1 : 0, borderColor: colors.border }}>
                    <Spans spans={cell} style={{ textAlign: block.align[c] ?? 'left', ...(r ? {} : { fontWeight: '600' }) }} />
                  </View>
                ))}
              </View>
            ))}
          </View>
        </ScrollView>
      );
    case 'rule':
      return <View style={{ height: 1, backgroundColor: colors.border, marginVertical: 4 }} />;
  }
}

function Blocks({ blocks }: { blocks: readonly MdBlock[] }) {
  return (
    <>
      {blocks.map((b, i) => (
        <Block key={i} block={b} />
      ))}
    </>
  );
}

/** A worker's reply as Markdown, drawn with native views; every paragraph and code block can be selected. */
export const Markdown = memo(function Markdown({ text }: { text: string }) {
  const blocks = useMemo(() => parseMarkdown(text), [text]);
  return (
    <View style={{ gap: 6 }} testID="markdown">
      <Blocks blocks={blocks} />
    </View>
  );
});
