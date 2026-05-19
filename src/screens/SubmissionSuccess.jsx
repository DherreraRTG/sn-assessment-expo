import { View, Text, TouchableOpacity, StyleSheet, Platform } from 'react-native';
import { useState } from 'react';

export default function SubmissionSuccess({ route, navigation }) {
  const { instanceNumber, answered, skipped, submittedAt, failedPhotoCount, totalPhotos } = route.params || {};
  const [closeFailed, setCloseFailed] = useState(false);

  const time = submittedAt
    ? new Date(submittedAt).toLocaleString()
    : new Date().toLocaleString();

  function handleClose() {
    if (Platform.OS === 'web') {
      window.close();
      // If still here after 300ms, the browser blocked it
      setTimeout(() => setCloseFailed(true), 300);
    } else {
      navigation.reset({ index: 0, routes: [{ name: 'MyAssessments' }] });
    }
  }

  return (
    <View style={s.container}>
      <View style={s.card}>
        <View style={s.iconWrap}>
          <Text style={s.icon}>✓</Text>
        </View>

        <Text style={s.heading}>Submitted Successfully</Text>

        <Text style={s.sub}>Your assessment has been submitted to ServiceNow.</Text>

        {failedPhotoCount > 0 && (
          <View style={s.warning}>
            <Text style={s.warningText}>
              <Text style={s.warningBold}>{failedPhotoCount} of {totalPhotos} photo{failedPhotoCount !== 1 ? 's' : ''} could not be uploaded.</Text>
              {' '}Your answers were saved. Please contact your administrator to re-upload the missing photos.
            </Text>
          </View>
        )}

        <View style={s.divider} />

        <Row label="Submitted at" value={time} />

        <View style={s.divider} />

        {closeFailed ? (
          <Text style={s.closeHint}>You can now close this tab.</Text>
        ) : (
          <TouchableOpacity style={s.btn} onPress={handleClose}>
            <Text style={s.btnText}>Close Window</Text>
          </TouchableOpacity>
        )}
      </View>
    </View>
  );
}

function Row({ label, value }) {
  return (
    <View style={s.row}>
      <Text style={s.rowLabel}>{label}</Text>
      <Text style={s.rowValue}>{value}</Text>
    </View>
  );
}

const s = StyleSheet.create({
  container: {
    flex: 1, backgroundColor: '#f2f4f7',
    justifyContent: 'center', alignItems: 'center', padding: 24,
  },
  card: {
    backgroundColor: '#fff', borderRadius: 4, padding: 28,
    width: '100%', maxWidth: 480,
    borderWidth: 1, borderColor: '#d8dde6',
    alignItems: 'center',
  },
  iconWrap: {
    width: 64, height: 64, borderRadius: 32,
    backgroundColor: '#e3f5e9', justifyContent: 'center', alignItems: 'center',
    marginBottom: 16,
  },
  icon: { fontSize: 32 },
  heading: {
    fontSize: 20, fontWeight: '700', color: '#1b1b38', marginBottom: 8, textAlign: 'center',
  },
  sub: {
    fontSize: 13, color: '#67717e', textAlign: 'center', lineHeight: 20, marginBottom: 4,
  },
  divider: { height: 1, backgroundColor: '#d8dde6', width: '100%', marginVertical: 20 },
  row: {
    flexDirection: 'row', justifyContent: 'space-between',
    width: '100%', paddingVertical: 5,
  },
  rowLabel: { fontSize: 13, color: '#67717e' },
  rowValue: { fontSize: 13, fontWeight: '600', color: '#1b1b38', flexShrink: 1, textAlign: 'right', marginLeft: 16 },
  btn: {
    marginTop: 4, backgroundColor: '#0070d2', borderRadius: 4,
    paddingVertical: 13, width: '100%', alignItems: 'center',
  },
  btnText: { color: '#fff', fontWeight: '700', fontSize: 14 },
  closeHint: { marginTop: 4, fontSize: 13, color: '#67717e', textAlign: 'center' },
  warning: {
    backgroundColor: '#fff8e1', borderWidth: 1, borderColor: '#f9a825', borderRadius: 4,
    padding: 12, marginTop: 12, width: '100%',
  },
  warningText: { fontSize: 13, color: '#5d4037', lineHeight: 20 },
  warningBold: { fontWeight: '700' },
});
