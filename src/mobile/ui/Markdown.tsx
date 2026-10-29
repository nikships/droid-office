import { memo, useMemo } from 'react';
import { Alert, Linking, ScrollView, Text, type TextStyle, View } from 'react-native';
import { keyed, type MdBlock, type MdSpan, parseMarkdown, plainText } from '../markdown';
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
      {keyed(spans, (x) => x.text).map(([key, x]) => (
        <Text
          key={key}
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
          <ScrollView horizontal nestedScrollEnabled>
            <Text selectable style={s.code}>
              {block.text}
            </Text>
          </ScrollView>
        </View>
      );
    case 'list':
      return (
        <View style={{ gap: 2 }}>
          {keyed(block.items, (item) => blockName(item.blocks[0])).map(([key, item], i) => (
            <View key={key} style={{ flexDirection: 'row', gap: 6 }}>
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
        <ScrollView horizontal nestedScrollEnabled>
          <View style={{ borderWidth: 1, borderColor: colors.border, borderRadius: 4 }}>
            {keyed([block.header, ...block.rows], (row) => row.map(plainText).join('|')).map(([rowKey, row], r) => (
              <View key={rowKey} style={{ flexDirection: 'row', borderTopWidth: r ? 1 : 0, borderColor: colors.border, backgroundColor: r ? undefined : colors.raised }}>
                {keyed(row, plainText).map(([cellKey, cell], c) => (
                  <View key={cellKey} style={{ width: 140, padding: 6, borderLeftWidth: c ? 1 : 0, borderColor: colors.border }}>
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

function blockName(b: MdBlock | undefined): string {
  if (!b) return '';
  if (b.kind === 'paragraph' || b.kind === 'heading') return `${b.kind}:${plainText(b.spans).slice(0, 64)}`;
  if (b.kind === 'code') return `code:${b.text.slice(0, 64)}`;
  return b.kind;
}

function Blocks({ blocks }: { blocks: readonly MdBlock[] }) {
  return (
    <>
      {keyed(blocks, blockName).map(([key, b]) => (
        <Block key={key} block={b} />
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
