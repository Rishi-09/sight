import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { colors } from './theme';

type Props = {
  serverStatus: string;
  reviewFirst: boolean;
  handsFree: boolean;
  wakeWord: boolean;
  wakeName: string;
  initialText?: string; // a transcript waiting for review
  onToggleReview: () => void;
  onToggleHandsFree: () => void;
  onToggleWakeWord: () => void;
  onRename: (name: string) => void;
  onOpenMaps: () => void;
  onOpenMemory: () => void;
  onSendTyped: (text: string) => void;
  onClose: () => void;
};

// Everything that isn't needed while walking lives here, so the main screen stays four big corners.
function Toggle({ label, hint, value, onPress }: { label: string; hint: string; value: boolean; onPress: () => void }) {
  return (
    <Pressable style={styles.toggle} onPress={onPress} accessibilityRole="switch" accessibilityState={{ checked: value }} accessibilityLabel={label} accessibilityHint={hint}>
      <View style={{ flex: 1 }}>
        <Text style={styles.body}>{label}</Text>
        <Text style={styles.sub}>{hint}</Text>
      </View>
      <Text style={[styles.body, { color: value ? colors.accent : colors.muted, fontWeight: '700' }]}>{value ? 'On' : 'Off'}</Text>
    </Pressable>
  );
}

export function MenuScreen({
  serverStatus,
  reviewFirst,
  handsFree,
  wakeWord,
  wakeName,
  initialText = '',
  onToggleReview,
  onToggleHandsFree,
  onToggleWakeWord,
  onRename,
  onOpenMaps,
  onOpenMemory,
  onSendTyped,
  onClose,
}: Props) {
  const [typed, setTyped] = useState(initialText);
  const [name, setName] = useState(wakeName);

  function send() {
    const text = typed.trim();
    if (!text) return;
    setTyped('');
    onSendTyped(text);
  }

  return (
    <ScrollView style={styles.root} contentContainerStyle={{ paddingBottom: 40 }} keyboardShouldPersistTaps="handled">
      <Text style={styles.title} accessibilityRole="header">Menu</Text>
      <Text style={styles.small}>
        Tip: you can also say "{wakeName}, open maps", "{wakeName}, open memory" or "{wakeName}, go back".
      </Text>

      <Pressable style={styles.big} onPress={onOpenMaps} accessibilityRole="button" accessibilityLabel="Maps: add places and record routes">
        <Text style={styles.bigText}>🗺  Maps</Text>
        <Text style={styles.sub}>Add places, record routes by walking them</Text>
      </Pressable>

      <Pressable style={styles.big} onPress={onOpenMemory} accessibilityRole="button" accessibilityLabel="Memory: review and delete what SIGHT remembers">
        <Text style={styles.bigText}>🧠  Memory</Text>
        <Text style={styles.sub}>Saved belongings, delete anything</Text>
      </Pressable>

      <Text style={styles.label}>Type a request</Text>
      <View style={styles.row}>
        <TextInput
          style={styles.input}
          value={typed}
          onChangeText={setTyped}
          onSubmitEditing={send}
          returnKeyType="send"
          placeholder="e.g. take me to the library"
          placeholderTextColor={colors.muted}
          accessibilityLabel="Type a request"
        />
        <Pressable style={styles.btn} onPress={send} accessibilityRole="button" accessibilityLabel="Send typed request">
          <Text style={styles.btnText}>Send</Text>
        </Pressable>
      </View>

      <Text style={styles.label}>My name (the wake word)</Text>
      <View style={styles.row}>
        <TextInput
          style={styles.input}
          value={name}
          onChangeText={setName}
          onSubmitEditing={() => onRename(name)}
          placeholder="Sight"
          placeholderTextColor={colors.muted}
          accessibilityLabel="Assistant name"
          autoCapitalize="words"
        />
        <Pressable style={styles.btn} onPress={() => onRename(name)} accessibilityRole="button" accessibilityLabel="Save name">
          <Text style={styles.btnText}>Save</Text>
        </Pressable>
      </View>
      <Text style={styles.sub}>Or say: "{wakeName}, change your name to Buddy".</Text>

      <Toggle label="Hands-free listening" hint="Always listening, no need to tap Talk" value={handsFree} onPress={onToggleHandsFree} />
      <Toggle label={`Wake word "${wakeName}"`} hint={`Only respond when a request starts with ${wakeName}`} value={wakeWord} onPress={onToggleWakeWord} />      <Toggle label="Review before sending" hint="Check what was heard before it's sent" value={reviewFirst} onPress={onToggleReview} />

      <Text style={styles.small}>{serverStatus}</Text>

      <Pressable style={styles.close} onPress={onClose} accessibilityRole="button" accessibilityLabel="Back to camera">
        <Text style={styles.closeText}>Back</Text>
      </Pressable>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg, padding: 16, paddingTop: 48 },
  title: { color: colors.fg, fontSize: 28, fontWeight: '700', marginBottom: 4 },
  label: { color: colors.accent, fontSize: 16, fontWeight: '700', marginTop: 16, marginBottom: 6 },
  body: { color: colors.fg, fontSize: 18 },
  small: { color: colors.muted, fontSize: 15, marginVertical: 8 },
  sub: { color: colors.muted, fontSize: 15, marginTop: 4 },
  big: { borderColor: colors.fg, borderWidth: 2, borderRadius: 16, padding: 18, marginTop: 12 },
  bigText: { color: colors.fg, fontSize: 24, fontWeight: '700' },
  row: { flexDirection: 'row', gap: 8, alignItems: 'center' },
  input: { flex: 1, color: colors.fg, borderColor: colors.muted, borderWidth: 1, borderRadius: 12, paddingHorizontal: 12, minHeight: 52, fontSize: 18 },
  btn: { minHeight: 52, minWidth: 84, borderColor: colors.fg, borderWidth: 2, borderRadius: 12, justifyContent: 'center', alignItems: 'center' },
  btnText: { color: colors.fg, fontSize: 18, fontWeight: '600' },
  toggle: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', minHeight: 64, marginTop: 12, borderColor: colors.muted, borderWidth: 1, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 8, gap: 8 },
  close: { minHeight: 64, justifyContent: 'center', alignItems: 'center', backgroundColor: colors.accent, borderRadius: 14, marginTop: 20 },
  closeText: { color: colors.bg, fontSize: 22, fontWeight: '800' },
});
