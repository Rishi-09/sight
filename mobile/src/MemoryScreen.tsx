import { useEffect, useState } from 'react';
import { Alert, FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { deleteObservation, forgetEverything, listObservations, Observation } from './api';
import { colors } from './theme';
import { speakNext } from './useVoice';

function when(iso: string) {
  const d = new Date(iso.endsWith('Z') || iso.includes('+') ? iso : iso + 'Z');
  return d.toLocaleString();
}

export function MemoryScreen({ onClose }: { onClose: () => void }) {
  const [items, setItems] = useState<Observation[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = (announce = false) =>
    listObservations()
      .then((x) => {
        setItems(x);
        setError(null);
        if (announce) {
          // Read the list aloud, so the screen is usable without seeing it.
          const top = x.slice(0, 5).map((o) => `${o.object_name}, ${o.location_note}`).join('. ');
          speakNext(x.length ? `${x.length} saved items. ${top}.` : 'Nothing saved yet.');
        }
      })
      .catch(() => setError("Couldn't reach the server."));

  useEffect(() => {
    load(true);
  }, []);

  const confirmForget = () =>
    Alert.alert('Delete everything?', 'This deletes all saved belongings, preferences, mission history and conversation.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete all', style: 'destructive', onPress: async () => { await forgetEverything(); load(); } },
    ]);

  return (
    <View style={styles.root}>
      <Text style={styles.title} accessibilityRole="header">
        What SIGHT remembers
      </Text>
      {error && <Text style={styles.body}>{error}</Text>}
      <FlatList
        data={items}
        keyExtractor={(o) => String(o.id)}
        ListEmptyComponent={<Text style={styles.body}>No saved belongings yet.</Text>}
        renderItem={({ item }) => (
          <View style={styles.row}>
            <View style={{ flex: 1 }} accessible accessibilityLabel={`${item.object_name}, ${item.location_note}, saved ${when(item.created_at)}`}>
              <Text style={styles.name}>{item.object_name}</Text>
              <Text style={styles.body}>{item.location_note}</Text>
              <Text style={styles.small}>{when(item.created_at)}</Text>
            </View>
            <Pressable
              style={styles.del}
              accessibilityRole="button"
              accessibilityLabel={`Delete ${item.object_name}`}
              onPress={async () => { await deleteObservation(item.id); load(); }}
            >
              <Text style={styles.delText}>Delete</Text>
            </Pressable>
          </View>
        )}
      />
      <Pressable style={styles.danger} accessibilityRole="button" onPress={confirmForget}>
        <Text style={styles.dangerText}>Delete everything</Text>
      </Pressable>
      <Pressable style={styles.close} accessibilityRole="button" accessibilityLabel="Close memory" onPress={onClose}>
        <Text style={styles.closeText}>Close</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg, padding: 16, paddingTop: 56 },
  title: { color: colors.fg, fontSize: 28, fontWeight: '700', marginBottom: 16 },
  row: { flexDirection: 'row', alignItems: 'center', borderBottomColor: colors.muted, borderBottomWidth: 1, paddingVertical: 12 },
  name: { color: colors.accent, fontSize: 22, fontWeight: '700' },
  body: { color: colors.fg, fontSize: 18 },
  small: { color: colors.muted, fontSize: 14 },
  del: { minHeight: 48, minWidth: 80, justifyContent: 'center', alignItems: 'center', borderColor: colors.fg, borderWidth: 2, borderRadius: 8 },
  delText: { color: colors.fg, fontSize: 18 },
  danger: { minHeight: 56, justifyContent: 'center', alignItems: 'center', backgroundColor: colors.danger, borderRadius: 12, marginTop: 12 },
  dangerText: { color: '#fff', fontSize: 20, fontWeight: '700' },
  close: { minHeight: 64, justifyContent: 'center', alignItems: 'center', backgroundColor: colors.accent, borderRadius: 12, marginTop: 12 },
  closeText: { color: colors.bg, fontSize: 22, fontWeight: '700' },
});
