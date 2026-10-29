import { type ReactNode, useEffect, useState } from 'react';
import { Pressable, type StyleProp, StyleSheet, Text, type TextStyle, useWindowDimensions, View, type ViewStyle } from 'react-native';
import type { WorkerStatus } from '../../shared/protocol';
import { colors, mono, radius } from './tokens';

export { colors, mono, radius } from './tokens';

export function useCompactHeight() {
  return useWindowDimensions().height < 600;
}

export const STATUS_COLOR: Record<WorkerStatus, string> = {
  starting: colors.info,
  idle: colors.muted,
  working: colors.accent,
  needs_input: colors.accent,
  done: colors.muted,
  exited: colors.muted,
  offline: colors.muted,
};

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
      <Text style={[s.buttonText, tone === 'primary' && s.primaryText, tone === 'danger' && s.dangerText, small && s.smallText]}>
        {label}
        {tone === 'primary' ? ' →' : ''}
      </Text>
    </Pressable>
  );
}

export function Chip(props: { label: string; index?: string; on?: boolean; onPress: () => void; disabled?: boolean; testID?: string; hint?: string; style?: StyleProp<ViewStyle> }) {
  return (
    <Pressable
      testID={props.testID}
      accessibilityRole="button"
      accessibilityHint={props.hint}
      accessibilityState={{ selected: !!props.on, disabled: !!props.disabled }}
      disabled={props.disabled}
      onPress={props.onPress}
      style={[s.chip, props.on && s.chipOn, props.disabled && s.disabled, props.style]}
    >
      {props.index ? <Text style={[s.label, { color: props.on ? colors.accent : colors.muted }]}>{props.index}</Text> : null}
      <Text style={[s.chipText, props.on && s.chipTextOn]} numberOfLines={1}>
        {props.label}
      </Text>
    </Pressable>
  );
}

export function StatusPill({ status, label }: { status: WorkerStatus; label: string }) {
  return (
    <View style={s.pill}>
      <View style={[s.statusDot, { backgroundColor: STATUS_COLOR[status] }]} />
      <Text style={[s.pillText, { color: STATUS_COLOR[status] }]}>{label}</Text>
    </View>
  );
}

export function Dot({ color }: { color: string }) {
  return <View style={[s.dot, { backgroundColor: color }]} />;
}

export function Eyebrow({ index, children }: { index: string; children: ReactNode }) {
  return (
    <Text style={s.label}>
      <Text style={{ color: colors.accent }}>{index}</Text>
      {' / '}
      {children}
    </Text>
  );
}

export function Metric({ value, label, accent }: { value: number; label: string; accent?: boolean }) {
  return (
    <View style={s.metric}>
      <Text style={[s.metricValue, accent && { color: colors.accent }]}>{String(value).padStart(2, '0')}</Text>
      <Label>{label}</Label>
    </View>
  );
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
  button: { minHeight: 44, paddingHorizontal: 16, paddingVertical: 12, borderRadius: radius, borderWidth: 1, borderColor: colors.borderStrong, backgroundColor: colors.surface, alignItems: 'center', justifyContent: 'center' },
  small: { minHeight: 36, paddingHorizontal: 12, paddingVertical: 8 },
  primary: { backgroundColor: colors.text, borderColor: colors.text },
  danger: { borderColor: colors.danger },
  dangerText: { color: colors.danger },
  ghost: { backgroundColor: 'transparent' },
  disabled: { opacity: 0.4 },
  pressed: { opacity: 0.75, borderColor: colors.accent },
  buttonText: { color: colors.text, fontFamily: mono, fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.7, fontWeight: '500' },
  smallText: { fontSize: 10 },
  primaryText: { color: colors.bg },
  chip: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, minHeight: 40, paddingHorizontal: 12, paddingVertical: 8, borderRadius: radius, borderWidth: 1, borderColor: colors.border, maxWidth: 240 },
  chipOn: { backgroundColor: colors.raised, borderColor: colors.borderStrong },
  chipText: { flexShrink: 1, color: colors.muted, fontFamily: mono, fontSize: 10, textTransform: 'uppercase', letterSpacing: 0.6 },
  chipTextOn: { color: colors.text },
  pill: { flexDirection: 'row', alignItems: 'center', gap: 6, borderWidth: 1, borderColor: colors.border, borderRadius: radius, paddingHorizontal: 8, paddingVertical: 4 },
  statusDot: { width: 4, height: 4 },
  pillText: { fontFamily: mono, fontSize: 9, textTransform: 'uppercase', letterSpacing: 0.5 },
  dot: { width: 6, height: 6, borderRadius: 1 },
  note: { borderWidth: 1, borderLeftWidth: 2, borderRadius: radius, padding: 12, marginVertical: 8, backgroundColor: colors.surface },
  noteText: { color: colors.text, fontSize: 13, lineHeight: 20 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  wrap: { flexWrap: 'wrap' },
  label: { color: colors.muted, fontFamily: mono, fontSize: 10, lineHeight: 16, textTransform: 'uppercase', letterSpacing: 1 },
  text: { color: colors.text, fontSize: 14, lineHeight: 22 },
  muted: { color: colors.muted, fontSize: 12, lineHeight: 18 },
  input: { minHeight: 44, color: colors.text, borderWidth: 1, borderColor: colors.borderStrong, borderRadius: radius, paddingHorizontal: 12, paddingVertical: 12, backgroundColor: colors.surface, fontSize: 14 },
  code: { color: colors.text, fontFamily: mono, fontSize: 12, lineHeight: 19, backgroundColor: colors.bg, padding: 8, borderRadius: radius },
  sheet: { flex: 1, backgroundColor: colors.bg, padding: 16 },
  title: { color: colors.text, fontSize: 20, lineHeight: 26, fontWeight: '500', letterSpacing: -0.4 },
  metric: { flex: 1, paddingVertical: 12, paddingHorizontal: 16, gap: 4, borderRightWidth: 1, borderColor: colors.border },
  metricValue: { color: colors.text, fontFamily: mono, fontSize: 24, lineHeight: 28 },
});
