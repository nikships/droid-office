import { Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { questionPresentation } from '../../shared/ask-question';
import { menuTakesText } from '../../shared/asks';
import { questionFeedback, questionReply, type QuestionDraft } from '../model';
import type { Session } from '../session';
import { Button, colors, Eyebrow, Label, Row, s } from './kit';

/** Lives inside App's safe root, not a native Modal that bypasses the host's system/IME insets. */
export function QuestionWorkspace({ session, draft, wide }: { session: Session; draft: QuestionDraft; wide: boolean }) {
  const display = questionPresentation(draft.menu, session.feeds.feed(draft.workerId)?.history.entries ?? []);
  const current = session.questionCurrent(draft);
  const supported = session.questionSupported(draft);
  const enabled = current && supported && draft.state === 'idle';
  const next = session.questionMenu(draft.workerId);
  const feedback = questionFeedback(draft, current, supported);
  return (
    <View style={{ flex: 1, backgroundColor: colors.bg, paddingHorizontal: wide ? 32 : 12, paddingVertical: wide ? 24 : 8 }} testID="question-workspace">
      <View style={{ flex: 1, width: '100%', maxWidth: 1120, alignSelf: 'center', gap: 20 }}>
        <Row wrap>
          <View style={{ flex: 1 }}>
            <Eyebrow index="02">Input required</Eyebrow>
            <Text style={s.title} accessibilityRole="header">
              Answer questions
            </Text>
            <Text style={s.muted}>
              {session.worker(draft.workerId)?.name ?? 'Worker'} · {draft.state === 'sent' ? 'Answer sent' : current ? 'Waiting for your answer' : 'Previous question'}
            </Text>
          </View>
          <Button label="Back to thread" onPress={() => session.closeQuestion()} testID="question-close" />
        </Row>
        <ScrollView style={{ flex: 1 }} contentContainerStyle={{ gap: 16, paddingBottom: 24 }} keyboardShouldPersistTaps="handled" testID="question-scroll">
          <Label>
            {display.position ? `Question ${display.position} of ${display.total}` : 'Current question'} · {draft.menu.multiSelect ? 'Multiple answers' : 'One answer'}
          </Label>
          <Text selectable style={[s.title, { fontSize: wide ? 24 : 20, lineHeight: wide ? 32 : 28 }]} testID="question-text">
            {display.question}
          </Text>
          <Text style={s.muted}>{draft.menu.multiSelect ? 'Select all that apply' : 'Select one answer'}. Nothing is sent until you submit.</Text>
          <View style={{ gap: 10 }}>
            {display.choices.map((choice) => {
              const checked = draft.choices.includes(choice.number);
              return (
                <Pressable
                  key={choice.number}
                  testID={`answer-${choice.number}`}
                  accessibilityRole={draft.menu.multiSelect ? 'checkbox' : 'radio'}
                  accessibilityLabel={`${choice.label}${choice.description ? `. ${choice.description}` : ''}`}
                  accessibilityState={{ checked, disabled: !enabled }}
                  disabled={!enabled}
                  onPress={() => session.selectAnswer(draft, choice.number)}
                  style={{ padding: wide ? 20 : 16, borderWidth: 1, borderRadius: 3, borderColor: checked ? colors.accent : colors.borderStrong, backgroundColor: checked ? colors.raised : colors.surface, flexDirection: 'row', gap: 12 }}
                >
                  <Text style={[s.text, { color: checked ? colors.accent : colors.muted }]} importantForAccessibility="no">
                    {draft.menu.multiSelect ? (checked ? '☑' : '☐') : checked ? '◉' : '○'}
                  </Text>
                  <View style={{ flex: 1, gap: 6 }}>
                    <Text style={[s.text, { fontSize: 16, lineHeight: 24 }]}>{choice.label}</Text>
                    {choice.description ? <Text style={s.muted}>{choice.description}</Text> : null}
                  </View>
                </Pressable>
              );
            })}
          </View>
          {menuTakesText(draft.menu) ? (
            <View style={{ gap: 8 }}>
              <Label>{draft.menu.multiSelect ? 'Add an answer (optional)' : 'Your own answer'}</Label>
              <TextInput
                testID="answer-text"
                accessibilityLabel="Your own answer"
                accessibilityState={{ disabled: !enabled }}
                style={[s.input, { minHeight: 100, textAlignVertical: 'top' }]}
                multiline
                maxLength={20000}
                editable={enabled}
                value={draft.text}
                onChangeText={(text) => session.writeAnswer(draft, text)}
                placeholder={draft.menu.multiSelect ? 'Add your own answer…' : 'Or write your own answer…'}
                placeholderTextColor={colors.muted}
              />
            </View>
          ) : null}
          {!display.complete ? <Text style={s.muted}>Showing the terminal’s readable text. If anything is missing, open Raw TTY.</Text> : null}
        </ScrollView>
        <View style={{ borderTopWidth: 1, borderColor: colors.border, paddingTop: 8, gap: 8 }} testID="question-footer">
          <Text style={s.muted} accessibilityLiveRegion="polite" testID="question-feedback">
            {feedback}
          </Text>
          {next && (!current || draft.state === 'uncertain') && draft.state !== 'sending' ? <Button label="Show current question" onPress={() => session.openQuestion(draft.workerId, true)} testID="question-review" /> : null}
          <Row wrap>
            <Button
              label="Raw TTY"
              onPress={() => {
                session.closeQuestion();
                session.view(draft.workerId, 'terminal');
              }}
              testID="question-raw"
            />
            <Text style={[s.muted, { flex: 1 }]}>{draft.choices.length ? `${draft.choices.length} selected` : draft.text.trim() ? 'Custom answer' : 'Choose an answer'}</Text>
            <Button label={draft.state === 'sending' ? 'Sending…' : 'Submit answer'} tone="primary" disabled={!enabled || !questionReply(draft)} onPress={() => void session.answer(draft)} testID="question-submit" />
          </Row>
        </View>
      </View>
    </View>
  );
}
