import { type ReactNode, useEffect, useState } from 'react';
import { Pressable, type StyleProp, StyleSheet, Text, type TextStyle, View, type ViewStyle } from 'react-native';
import type { WorkerStatus } from '../../shared/protocol';

/** Basic components only: the office's dark palette, no styling work beyond legibility. */
export const colors = {
  bg: '#0d0d0f',
  surface: '#17171a',
  raised: '#202024',
  border: '#2c2c31',
  text: '#ececef',
  muted: '#9b9ba3',
  accent: '#ff6a2b',
  danger: '#ff5c5c',
  warn: '#ffb81c',
  good: '#3ecf8e',
  info: '#5aa2ff',
};

export const STATUS_COLOR: Record<WorkerStatus, string> = {
  starting: colors.info,
  idle: colors.muted,
  working: colors.accent,
  needs_input: colors.warn,
  done: colors.good,
  exited: colors.muted,
  offline: colors.muted,
};

export const mono = 'monospace';

export function Button(props: { label: string; onPress: () => void; disabled?: boolean; tone?: 'primary' | 'danger' | 'ghost'; small?: boolean; testID?: string; accessibilityLabel?: string }) {
  const { label, onPress, disabled, tone, small, testID } = props;
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={props.accessibilityLabel ?? label}
      accessibilityState={{ disabled: !!disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [s.button, small && s.small, tone === 'primary' && s.primary, tone === 'danger' && s.danger, tone === 'ghost' && s.ghost, disabled && s.disabled, pressed && s.pressed]}
    >
      <Text style={[s.buttonText, tone === 'primary' && s.primaryText, small && s.smallText]}>{label}</Text>
    </Pressable>
  );
}

export function Chip(props: { label: string; on?: boolean; onPress: () => void; disabled?: boolean; testID?: string }) {
  return (
    <Pressable
      testID={props.testID}
      accessibilityRole="button"
      accessibilityState={{ selected: !!props.on, disabled: !!props.disabled }}
      disabled={props.disabled}
      onPress={props.onPress}
      style={[s.chip, props.on && s.chipOn, props.disabled && s.disabled]}
    >
      <Text style={[s.chipText, props.on && s.chipTextOn]} numberOfLines={1}>
        {props.label}
      </Text>
    </Pressable>
  );
}

export function StatusPill({ status, label }: { status: WorkerStatus; label: string }) {
  return (
    <View style={[s.pill, { borderColor: STATUS_COLOR[status] }]}>
      <Text style={[s.pillText, { color: STATUS_COLOR[status] }]}>{label}</Text>
    </View>
  );
}

export function Dot({ color }: { color: string }) {
  return <View style={[s.dot, { backgroundColor: color }]} />;
}

export function Note({ children, tone = 'info' }: { children: ReactNode; tone?: 'info' | 'warn' | 'bad' | 'good' }) {
  const color = tone === 'warn' ? colors.warn : tone === 'bad' ? colors.danger : tone === 'good' ? colors.good : colors.info;
  return (
    <View style={[s.note, { borderColor: color }]}>
      <Text style={s.noteText}>{children}</Text>
    </View>
  );
}

export function Row({ children, style, wrap }: { children: ReactNode; style?: StyleProp<ViewStyle>; wrap?: boolean }) {
  return <View style={[s.row, wrap && s.wrap, style]}>{children}</View>;
}

export function Label({ children, style }: { children: ReactNode; style?: StyleProp<TextStyle> }) {
  return <Text style={[s.label, style]}>{children}</Text>;
}

/** Re-renders every `ms` so durations move; only mounted where a duration is shown. */
export function useNow(ms = 1000): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(timer);
  }, [ms]);
  return now;
}

export const s = StyleSheet.create({
  button: { paddingHorizontal: 12, paddingVertical: 8, borderRadius: 4, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.raised, alignItems: 'center', justifyContent: 'center' },
  small: { paddingHorizontal: 8, paddingVertical: 4 },
  primary: { backgroundColor: colors.text, borderColor: colors.text },
  danger: { borderColor: colors.danger },
  ghost: { backgroundColor: 'transparent' },
  disabled: { opacity: 0.4 },
  pressed: { opacity: 0.7 },
  buttonText: { color: colors.text, fontSize: 13 },
  smallText: { fontSize: 12 },
  primaryText: { color: colors.bg },
  chip: { paddingHorizontal: 10, paddingVertical: 6, borderRadius: 12, borderWidth: 1, borderColor: colors.border, marginRight: 6, maxWidth: 220 },
  chipOn: { backgroundColor: colors.accent, borderColor: colors.accent },
  chipText: { color: colors.text, fontSize: 12 },
  chipTextOn: { color: colors.bg },
  pill: { borderWidth: 1, borderRadius: 3, paddingHorizontal: 5, paddingVertical: 1 },
  pillText: { fontSize: 10.5, textTransform: 'uppercase' },
  dot: { width: 10, height: 10, borderRadius: 5, marginRight: 8 },
  note: { borderLeftWidth: 3, paddingHorizontal: 10, paddingVertical: 6, marginVertical: 6, backgroundColor: colors.surface },
  noteText: { color: colors.text, fontSize: 13 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  wrap: { flexWrap: 'wrap' },
  label: { color: colors.muted, fontSize: 10.5, textTransform: 'uppercase', letterSpacing: 0.5 },
  text: { color: colors.text, fontSize: 13.5 },
  muted: { color: colors.muted, fontSize: 12 },
  input: { color: colors.text, borderWidth: 1, borderColor: colors.border, borderRadius: 4, paddingHorizontal: 10, paddingVertical: 8, backgroundColor: colors.surface, fontSize: 14 },
  code: { color: colors.text, fontFamily: mono, fontSize: 12, backgroundColor: colors.bg, padding: 8, borderRadius: 4 },
  sheet: { flex: 1, backgroundColor: colors.bg, padding: 16 },
  title: { color: colors.text, fontSize: 16, fontWeight: '500' },
});
