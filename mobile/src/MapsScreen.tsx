import { useEffect, useState } from 'react';
import { ActivityIndicator, Alert, FlatList, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import MapView, { Marker, Polyline } from 'react-native-maps';
import * as Haptics from 'expo-haptics';
import Constants, { ExecutionEnvironment } from 'expo-constants';

import { addWaypoint, Coords, createPlace, deletePlace, deleteWaypoint, listPlaces, Place, updatePlace } from './api';
import { colors } from './theme';
import { speak, speakNext } from './useVoice';

// Google Maps on Android needs an API key. Expo Go ships its own; a standalone APK only has one if
// GOOGLE_MAPS_API_KEY was set at build time (app.config.js then sets extra.mapsEnabled). Without a
// key, rendering MapView crashes the app, so the map preview is skipped (recording still works).
const MAP_PREVIEW_AVAILABLE =
  Constants.executionEnvironment === ExecutionEnvironment.StoreClient || Constants.expoConfig?.extra?.mapsEnabled === true;

// dictate: records one utterance with the app's shared recorder (stops by itself when you stop talking).
type Props = { coords: Coords; accuracy: number | null; heading: number | null; dictate: () => Promise<string>; onClose: () => void };

// "CS-204: First floor, turn right" per line  <->  { "CS-204": "First floor, turn right" }
const roomsToText = (rooms: Record<string, string>) => Object.entries(rooms).map(([k, v]) => `${k}: ${v}`).join('\n');
function textToRooms(text: string) {
  const rooms: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const i = line.indexOf(':');
    if (i > 0 && line.slice(i + 1).trim()) rooms[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return rooms;
}

export function MapsScreen({ coords, accuracy, heading, dictate, onClose }: Props) {
  const [places, setPlaces] = useState<Place[]>([]);
  const [selected, setSelected] = useState<Place | null>(null);
  const [newName, setNewName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = async (keepId?: number | null, announce = false) => {
    try {
      const all = await listPlaces();
      setPlaces(all);
      setError(null);
      if (announce) speakNext(`${all.length} places: ${all.map((p) => p.name).join(', ')}.`);
      if (keepId != null) setSelected(all.find((p) => p.id === keepId) ?? null);
    } catch (e: any) {
      setError(`Couldn't load places: ${e?.message ?? e}`);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load(undefined, true);
  }, []);

  async function onCreate() {
    const name = newName.trim();
    if (!name) return;
    try {
      const p = await createPlace({ name });
      setNewName('');
      await load(p.id);
      speak(`${name} created. Walk the route and drop a point at each turn.`);
    } catch (e: any) {
      setError(String(e?.message ?? e));
    }
  }

  if (selected) {
    return <PlaceEditor place={selected} coords={coords} accuracy={accuracy} heading={heading} dictate={dictate} onBack={() => { setSelected(null); load(); }} onChanged={() => load(selected.id)} />;
  }

  return (
    <View style={styles.root}>
      <Text style={styles.title} accessibilityRole="header">Maps</Text>
      <Text style={styles.small}>Places SIGHT can guide people to. Create one, then walk its route and drop points.</Text>
      {error && <Text style={styles.error}>{error}</Text>}

      <View style={styles.row}>
        <TextInput
          style={[styles.input, { flex: 1 }]}
          value={newName}
          onChangeText={setNewName}
          placeholder="New place name, e.g. Hostel Block B"
          placeholderTextColor={colors.muted}
          accessibilityLabel="New place name"
          onSubmitEditing={onCreate}
        />
        <Pressable style={styles.btn} onPress={onCreate} accessibilityRole="button" accessibilityLabel="Create place">
          <Text style={styles.btnText}>Create</Text>
        </Pressable>
      </View>

      {loading ? (
        <ActivityIndicator color={colors.accent} />
      ) : (
        <FlatList
          data={places}
          keyExtractor={(p, i) => `${p.source}-${p.id ?? p.name}-${i}`}
          renderItem={({ item }) => (
            <Pressable
              style={styles.card}
              onPress={() => (item.source === 'recorded' ? setSelected(item) : Alert.alert(item.name, 'Sample destination from campus.json (read-only).'))}
              accessibilityRole="button"
              accessibilityLabel={`${item.name}, ${item.waypoints.length} route points, ${item.source === 'sample' ? 'sample' : 'recorded'}`}
            >
              <Text style={styles.cardTitle}>{item.name}</Text>
              <Text style={styles.small}>
                {item.waypoints.length} points · {item.source === 'sample' ? 'sample (read-only)' : 'recorded'}
              </Text>
            </Pressable>
          )}
        />
      )}

      <Pressable style={styles.close} onPress={onClose} accessibilityRole="button" accessibilityLabel="Back to camera">
        <Text style={styles.closeText}>Back</Text>
      </Pressable>
    </View>
  );
}

function PlaceEditor({ place, coords, accuracy, heading, dictate, onBack, onChanged }: { place: Place; coords: Coords; accuracy: number | null; heading: number | null; dictate: () => Promise<string>; onBack: () => void; onChanged: () => void }) {
  const [dictating, setDictating] = useState(false);
  const [instruction, setInstruction] = useState('');
  const [landmark, setLandmark] = useState('');
  const [aliases, setAliases] = useState(place.aliases);
  const [entrance, setEntrance] = useState(place.entrance);
  const [rooms, setRooms] = useState(roomsToText(place.rooms));
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');

  const pts = place.waypoints.map((w) => ({ latitude: w.lat, longitude: w.lng }));
  const center = pts[pts.length - 1] ?? (coords ? { latitude: coords.lat, longitude: coords.lng } : { latitude: 28.6139, longitude: 77.209 });

  async function dropPoint() {
    if (!coords) {
      speak('No GPS fix yet. Wait a moment, preferably outdoors.');
      return;
    }
    setBusy(true);
    try {
      await addWaypoint(place.id!, {
        lat: coords.lat,
        lng: coords.lng,
        heading,
        instruction: instruction.trim() || `Continue to point ${place.waypoints.length + 1}.`,
        landmark_hint: landmark.trim(),
      });
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      setMsg(`Point ${place.waypoints.length + 1} saved${accuracy ? ` (±${Math.round(accuracy)} m)` : ''}.`);
      setInstruction('');
      setLandmark('');
      onChanged();
    } catch (e: any) {
      setMsg(`Save failed: ${e?.message ?? e}`);
    } finally {
      setBusy(false);
    }
  }

  async function onDictate() {
    if (dictating) return;
    setDictating(true);
    setMsg('Listening… speak the instruction; it stops when you stop.');
    try {
      const text = await dictate();
      if (text) setInstruction(text);
      setMsg(text ? 'Instruction filled from your voice.' : "Didn't catch that.");
    } catch (e: any) {
      setMsg(`Dictation failed: ${e?.message ?? e}`);
    } finally {
      setDictating(false);
    }
  }

  async function saveDetails() {
    try {
      await updatePlace(place.id!, { name: place.name, aliases, entrance, rooms: textToRooms(rooms) });
      setMsg('Details saved.');
      onChanged();
    } catch (e: any) {
      setMsg(`Save failed: ${e?.message ?? e}`);
    }
  }

  function confirmDelete() {
    Alert.alert(`Delete ${place.name}?`, 'This removes the place and its recorded route.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: async () => { await deletePlace(place.id!); onBack(); } },
    ]);
  }

  return (
    <ScrollView style={styles.root} contentContainerStyle={{ paddingBottom: 40 }} keyboardShouldPersistTaps="handled">
      <Text style={styles.title} accessibilityRole="header">{place.name}</Text>

      {MAP_PREVIEW_AVAILABLE ? (
        <MapView
          key={`${place.id}-${pts.length}`}
          style={styles.map}
          showsUserLocation
          initialRegion={{ ...center, latitudeDelta: 0.004, longitudeDelta: 0.004 }}
          accessibilityLabel={`Map with ${pts.length} recorded points`}
        >
          {pts.length > 1 && <Polyline coordinates={pts} strokeColor={colors.accent} strokeWidth={5} />}
          {place.waypoints.map((w) => (
            <Marker key={w.id ?? w.seq} coordinate={{ latitude: w.lat, longitude: w.lng }} title={`${w.seq}. ${w.instruction}`} description={w.landmark_hint} />
          ))}
        </MapView>
      ) : (
        <View style={[styles.map, styles.noMap]}>
          <Text style={styles.small}>Map preview needs a Google Maps API key in this build. Recording points and guidance work without it.</Text>
        </View>
      )}

      <Text style={styles.small}>
        GPS: {coords ? `${coords.lat.toFixed(5)}, ${coords.lng.toFixed(5)}` : 'waiting…'}
        {accuracy != null ? ` · ±${Math.round(accuracy)} m` : ''}
        {heading != null ? ` · facing ${heading}°` : ''}
      </Text>

      <Text style={styles.label}>Instruction at this point</Text>
      <View style={styles.row}>
        <TextInput
          style={[styles.input, { flex: 1 }]}
          value={instruction}
          onChangeText={setInstruction}
          placeholder="e.g. Turn right at the notice board"
          placeholderTextColor={colors.muted}
          accessibilityLabel="Instruction at this point"
        />
        <Pressable style={[styles.btn, dictating && { backgroundColor: colors.recording }]} onPress={onDictate} disabled={dictating} accessibilityRole="button" accessibilityLabel={dictating ? 'Listening' : 'Dictate instruction'}>
          <Text style={styles.btnText}>{dictating ? '…' : 'Dictate'}</Text>
        </Pressable>
      </View>
      <TextInput
        style={styles.input}
        value={landmark}
        onChangeText={setLandmark}
        placeholder="Landmark hint (sound, smell, texture…) optional"
        placeholderTextColor={colors.muted}
        accessibilityLabel="Landmark hint, optional"
      />
      <Pressable style={[styles.primary, busy && { opacity: 0.5 }]} onPress={dropPoint} disabled={busy} accessibilityRole="button" accessibilityLabel="Drop a route point at my current location">
        <Text style={styles.primaryText}>Drop point here</Text>
      </Pressable>
      {!!msg && <Text style={styles.small}>{msg}</Text>}

      <Text style={styles.label}>Route ({place.waypoints.length} points)</Text>
      {place.waypoints.map((w) => (
        <View key={w.id ?? w.seq} style={styles.wp}>
          <Text style={[styles.body, { flex: 1 }]}>
            {w.seq}. {w.instruction}
            {w.landmark_hint ? ` (${w.landmark_hint})` : ''}
          </Text>
          <Pressable style={styles.smallBtn} onPress={async () => { await deleteWaypoint(w.id!); onChanged(); }} accessibilityRole="button" accessibilityLabel={`Delete point ${w.seq}`}>
            <Text style={styles.btnText}>✕</Text>
          </Pressable>
        </View>
      ))}

      <Text style={styles.label}>Other names (comma-separated)</Text>
      <TextInput style={styles.input} value={aliases} onChangeText={setAliases} placeholder="hostel, block b" placeholderTextColor={colors.muted} />
      <Text style={styles.label}>Entrance description (the camera looks for this)</Text>
      <TextInput style={[styles.input, styles.multi]} value={entrance} onChangeText={setEntrance} multiline placeholder="Green gate with a guard cabin on the left" placeholderTextColor={colors.muted} />
      <Text style={styles.label}>Rooms, one per line as "name: directions"</Text>
      <TextInput style={[styles.input, styles.multi]} value={rooms} onChangeText={setRooms} multiline placeholder={'B-12: First floor, second door on the left'} placeholderTextColor={colors.muted} />
      <Pressable style={styles.btnWide} onPress={saveDetails} accessibilityRole="button">
        <Text style={styles.btnText}>Save details</Text>
      </Pressable>

      <Pressable style={styles.danger} onPress={confirmDelete} accessibilityRole="button">
        <Text style={styles.dangerText}>Delete place</Text>
      </Pressable>
      <Pressable style={styles.close} onPress={onBack} accessibilityRole="button" accessibilityLabel="Back to places">
        <Text style={styles.closeText}>Back to places</Text>
      </Pressable>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg, padding: 16, paddingTop: 48 },
  title: { color: colors.fg, fontSize: 28, fontWeight: '700', marginBottom: 8 },
  label: { color: colors.accent, fontSize: 16, fontWeight: '700', marginTop: 16, marginBottom: 6 },
  body: { color: colors.fg, fontSize: 17 },
  small: { color: colors.muted, fontSize: 15, marginVertical: 6 },
  error: { color: colors.recording, fontSize: 16, marginVertical: 6 },
  row: { flexDirection: 'row', gap: 8, alignItems: 'center', marginVertical: 6 },
  input: { color: colors.fg, borderColor: colors.muted, borderWidth: 1, borderRadius: 12, paddingHorizontal: 12, minHeight: 48, fontSize: 17, marginVertical: 4 },
  multi: { minHeight: 80, textAlignVertical: 'top', paddingTop: 10 },
  map: { height: 240, borderRadius: 16, marginVertical: 8 },
  noMap: { height: 90, borderWidth: 1, borderColor: colors.muted, justifyContent: 'center', padding: 12 },
  card: { borderColor: colors.muted, borderWidth: 1, borderRadius: 12, padding: 14, marginVertical: 6 },
  cardTitle: { color: colors.fg, fontSize: 20, fontWeight: '700' },
  btn: { minHeight: 48, minWidth: 84, paddingHorizontal: 12, borderColor: colors.fg, borderWidth: 2, borderRadius: 12, justifyContent: 'center', alignItems: 'center' },
  btnWide: { minHeight: 52, borderColor: colors.fg, borderWidth: 2, borderRadius: 12, justifyContent: 'center', alignItems: 'center', marginTop: 12 },
  btnText: { color: colors.fg, fontSize: 17, fontWeight: '600' },
  smallBtn: { minHeight: 44, minWidth: 44, borderColor: colors.muted, borderWidth: 1, borderRadius: 10, justifyContent: 'center', alignItems: 'center' },
  primary: { minHeight: 64, backgroundColor: colors.accent, borderRadius: 14, justifyContent: 'center', alignItems: 'center', marginTop: 10 },
  primaryText: { color: colors.bg, fontSize: 22, fontWeight: '800' },
  wp: { flexDirection: 'row', alignItems: 'center', gap: 8, borderBottomColor: '#222', borderBottomWidth: 1, paddingVertical: 8 },
  danger: { minHeight: 52, justifyContent: 'center', alignItems: 'center', backgroundColor: colors.danger, borderRadius: 12, marginTop: 24 },
  dangerText: { color: '#fff', fontSize: 18, fontWeight: '700' },
  close: { minHeight: 60, justifyContent: 'center', alignItems: 'center', backgroundColor: colors.accent, borderRadius: 12, marginTop: 12 },
  closeText: { color: colors.bg, fontSize: 20, fontWeight: '700' },
});
