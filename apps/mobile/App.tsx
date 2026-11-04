import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  AppState,
  Pressable,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import {
  SafeAreaProvider,
  SafeAreaView,
} from 'react-native-safe-area-context';
import {
  initializeLocalReports,
  reportQueueService,
  reportRepository,
} from './src/localReports';
import type { LocalReport } from './src/reports/model';

function App() {
  const [reports, setReports] = useState<LocalReport[]>([]);
  const [description, setDescription] = useState('');
  const [draftId, setDraftId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const refreshReports = useCallback(async () => {
    setReports(await reportRepository.listReports());
  }, []);

  useEffect(() => {
    let active = true;
    const load = async (initialize: boolean) => {
      try {
        if (initialize) {
          await initializeLocalReports();
        }
        const savedReports = await reportRepository.listReports();
        if (active) {
          setReports(savedReports);
          setError(null);
        }
      } catch (loadError) {
        if (active) {
          setError(errorMessage(loadError));
        }
      } finally {
        if (active) {
          setLoading(false);
        }
      }
    };

    load(true);
    const subscription = AppState.addEventListener('change', state => {
      if (state === 'active') {
        load(true);
      }
    });

    return () => {
      active = false;
      subscription.remove();
    };
  }, []);

  const currentDraft = useMemo(
    () => reports.find(report => report.localId === draftId),
    [draftId, reports],
  );
  const imageCount = currentDraft?.images.length ?? 0;
  const canQueue =
    Boolean(draftId) &&
    Boolean(description.trim()) &&
    imageCount >= 1 &&
    imageCount <= 5;

  const saveDraft = async () => {
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const savedReport = draftId
        ? await reportRepository.updateDraftDescription(draftId, description)
        : await reportRepository.createDraft(description);
      setDraftId(savedReport.localId);
      setDescription(savedReport.description);
      await refreshReports();
      setNotice('Draft saved on this device.');
    } catch (saveError) {
      setError(errorMessage(saveError));
    } finally {
      setSaving(false);
    }
  };

  const queueDraft = async () => {
    if (!draftId) {
      setError('Save a draft before queueing it.');
      return;
    }
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      await reportQueueService.queueReport(draftId);
      setDraftId(null);
      setDescription('');
      await refreshReports();
      setNotice('Report queued for a future upload.');
    } catch (queueError) {
      setError(errorMessage(queueError));
    } finally {
      setSaving(false);
    }
  };

  const startNewDraft = () => {
    setDraftId(null);
    setDescription('');
    setError(null);
    setNotice(null);
  };

  const editDraft = (report: LocalReport) => {
    if (report.status !== 'draft') {
      return;
    }
    setDraftId(report.localId);
    setDescription(report.description);
    setError(null);
    setNotice(null);
  };

  return (
    <SafeAreaProvider>
      <StatusBar barStyle="dark-content" />
      <SafeAreaView style={styles.safeArea}>
        <ScrollView
          contentContainerStyle={styles.container}
          keyboardShouldPersistTaps="handled">
          <View style={styles.brand}>
            <View style={styles.brandMark}>
              <Text style={styles.brandMarkText}>F</Text>
            </View>
            <View>
              <Text style={styles.brandName}>FIELD REPORTING</Text>
              <Text style={styles.brandCaption}>OFFLINE WORKSPACE</Text>
            </View>
          </View>

          <View style={styles.intro}>
            <Text style={styles.eyebrow}>FIELD OPERATIONS</Text>
            <Text style={styles.title}>Field Reporting</Text>
            <Text style={styles.subtitle}>
              Save report drafts securely on this device.
            </Text>
          </View>

          {error ? (
            <View style={styles.errorCard} accessibilityRole="alert">
              <Text style={styles.errorTitle}>Could not complete that action</Text>
              <Text style={styles.errorText}>{error}</Text>
            </View>
          ) : null}
          {notice ? <Text style={styles.notice}>{notice}</Text> : null}

          <View style={styles.formCard}>
            <Text style={styles.sectionTitle}>
              {draftId ? 'Edit local draft' : 'New local draft'}
            </Text>
            <Text style={styles.label}>Report description</Text>
            <TextInput
              accessibilityLabel="Report description"
              multiline
              onChangeText={value => {
                setDescription(value);
                setNotice(null);
              }}
              placeholder="Describe what happened in the field"
              placeholderTextColor="#87938F"
              style={styles.input}
              textAlignVertical="top"
              value={description}
            />
            <View style={styles.imageNotice}>
              <Text style={styles.imageCount}>
                {imageCount} {imageCount === 1 ? 'image' : 'images'} attached
              </Text>
              <Text style={styles.imageLimitation}>
                Image selection is not available yet. Reports need 1–5 images
                before they can be queued.
              </Text>
            </View>
            <View style={styles.actions}>
              <Pressable
                accessibilityRole="button"
                disabled={saving || loading}
                onPress={() => saveDraft()}
                style={({ pressed }) => [
                  styles.primaryButton,
                  (pressed || saving || loading) && styles.buttonMuted,
                ]}>
                <Text style={styles.primaryButtonText}>
                  {saving
                    ? 'Saving…'
                    : draftId
                      ? 'Save draft locally'
                      : 'Create draft locally'}
                </Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                disabled={!canQueue || saving || loading}
                onPress={() => queueDraft()}
                style={({ pressed }) => [
                  styles.secondaryButton,
                  (!canQueue || saving || loading || pressed) &&
                    styles.buttonMuted,
                ]}>
                <Text
                  style={[
                    styles.secondaryButtonText,
                    (!canQueue || saving || loading) && styles.disabledText,
                  ]}>
                  Queue report
                </Text>
              </Pressable>
            </View>
            {draftId ? (
              <Pressable
                accessibilityRole="button"
                onPress={startNewDraft}
                style={styles.textButton}>
                <Text style={styles.textButtonLabel}>Start another draft</Text>
              </Pressable>
            ) : null}
          </View>

          <View style={styles.listHeading}>
            <Text style={styles.sectionTitle}>Saved reports</Text>
            <Text style={styles.reportTotal}>{reports.length}</Text>
          </View>

          {loading ? (
            <View style={styles.emptyState}>
              <ActivityIndicator color="#397B68" />
              <Text style={styles.emptyText}>Loading local reports…</Text>
            </View>
          ) : reports.length === 0 ? (
            <View style={styles.emptyState}>
              <Text style={styles.emptyTitle}>No reports saved yet</Text>
              <Text style={styles.emptyText}>
                Create a draft above. It will remain available on this device
                when you reopen the app.
              </Text>
            </View>
          ) : (
            <View style={styles.reportList}>
              {reports.map(report => (
                <Pressable
                  accessibilityRole={
                    report.status === 'draft' ? 'button' : undefined
                  }
                  key={report.localId}
                  onPress={() => editDraft(report)}
                  style={[
                    styles.reportCard,
                    report.localId === draftId && styles.selectedReport,
                  ]}>
                  <View style={styles.reportTopLine}>
                    <Text
                      numberOfLines={1}
                      style={styles.reportDescription}>
                      {report.description.trim() || 'Untitled draft'}
                    </Text>
                    <Text
                      style={[
                        styles.status,
                        statusStyles[report.status],
                      ]}>
                      {report.status}
                    </Text>
                  </View>
                  <Text style={styles.reportMeta}>
                    {report.images.length}{' '}
                    {report.images.length === 1 ? 'image' : 'images'} ·{' '}
                    {new Date(report.createdAt).toLocaleString()}
                  </Text>
                  {report.status === 'draft' ? (
                    <Text style={styles.editHint}>Tap to edit this draft</Text>
                  ) : null}
                  {report.lastError ? (
                    <Text style={styles.reportError}>{report.lastError}</Text>
                  ) : null}
                </Pressable>
              ))}
            </View>
          )}
        </ScrollView>
      </SafeAreaView>
    </SafeAreaProvider>
  );
}

const statusStyles = StyleSheet.create({
  draft: { backgroundColor: '#EEF2F0', color: '#52625D' },
  queued: { backgroundColor: '#E8F2ED', color: '#31745D' },
  uploading: { backgroundColor: '#FFF2D8', color: '#936319' },
  retrying: { backgroundColor: '#FFF2D8', color: '#936319' },
  uploaded: { backgroundColor: '#E4F1EA', color: '#286A4E' },
  failed: { backgroundColor: '#FCE9E7', color: '#A73D35' },
});

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: '#F4F6F5',
  },
  container: {
    paddingHorizontal: 22,
    paddingTop: 16,
    paddingBottom: 32,
  },
  brand: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  brandMark: {
    width: 42,
    height: 42,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 13,
    backgroundColor: '#163B35',
  },
  brandMarkText: {
    color: '#FFFFFF',
    fontSize: 22,
    fontWeight: '700',
  },
  brandName: {
    color: '#193B35',
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 1.2,
  },
  brandCaption: {
    marginTop: 3,
    color: '#75847F',
    fontSize: 10,
    fontWeight: '600',
    letterSpacing: 1,
  },
  intro: {
    marginTop: 35,
    marginBottom: 22,
  },
  eyebrow: {
    color: '#438272',
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 1.5,
  },
  title: {
    marginTop: 9,
    color: '#18332E',
    fontSize: 32,
    fontWeight: '700',
    letterSpacing: -0.8,
  },
  subtitle: {
    marginTop: 7,
    color: '#64736F',
    fontSize: 15,
    lineHeight: 22,
  },
  errorCard: {
    marginBottom: 14,
    padding: 14,
    borderWidth: 1,
    borderColor: '#F0CBC7',
    borderRadius: 12,
    backgroundColor: '#FFF5F4',
  },
  errorTitle: {
    color: '#9B332B',
    fontSize: 13,
    fontWeight: '700',
  },
  errorText: {
    marginTop: 4,
    color: '#793D38',
    fontSize: 13,
    lineHeight: 19,
  },
  notice: {
    marginBottom: 12,
    color: '#31745D',
    fontSize: 13,
    fontWeight: '600',
  },
  formCard: {
    padding: 18,
    borderWidth: 1,
    borderColor: '#E1E9E5',
    borderRadius: 18,
    backgroundColor: '#FFFFFF',
  },
  sectionTitle: {
    color: '#18332E',
    fontSize: 18,
    fontWeight: '700',
  },
  label: {
    marginTop: 17,
    marginBottom: 7,
    color: '#52625D',
    fontSize: 12,
    fontWeight: '700',
  },
  input: {
    minHeight: 94,
    paddingHorizontal: 12,
    paddingVertical: 11,
    borderWidth: 1,
    borderColor: '#DCE5E1',
    borderRadius: 11,
    color: '#18332E',
    fontSize: 15,
    lineHeight: 21,
    backgroundColor: '#FBFCFB',
  },
  imageNotice: {
    marginTop: 14,
    padding: 12,
    borderRadius: 10,
    backgroundColor: '#F1F6F3',
  },
  imageCount: {
    color: '#31745D',
    fontSize: 13,
    fontWeight: '700',
  },
  imageLimitation: {
    marginTop: 4,
    color: '#61736C',
    fontSize: 12,
    lineHeight: 18,
  },
  actions: {
    marginTop: 15,
    gap: 9,
  },
  primaryButton: {
    minHeight: 46,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 14,
    borderRadius: 11,
    backgroundColor: '#163B35',
  },
  primaryButtonText: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '700',
  },
  secondaryButton: {
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 14,
    borderWidth: 1,
    borderColor: '#DCE5E1',
    borderRadius: 11,
    backgroundColor: '#FFFFFF',
  },
  secondaryButtonText: {
    color: '#31745D',
    fontSize: 14,
    fontWeight: '700',
  },
  disabledText: {
    color: '#98A49F',
  },
  buttonMuted: {
    opacity: 0.55,
  },
  textButton: {
    alignSelf: 'center',
    paddingTop: 13,
  },
  textButtonLabel: {
    color: '#397B68',
    fontSize: 13,
    fontWeight: '600',
  },
  listHeading: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 28,
    marginBottom: 12,
  },
  reportTotal: {
    minWidth: 28,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 10,
    color: '#397B68',
    fontSize: 12,
    fontWeight: '700',
    textAlign: 'center',
    backgroundColor: '#E7F0EC',
  },
  emptyState: {
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingVertical: 28,
    borderWidth: 1,
    borderColor: '#E1E9E5',
    borderRadius: 16,
    backgroundColor: '#FFFFFF',
  },
  emptyTitle: {
    color: '#18332E',
    fontSize: 15,
    fontWeight: '700',
  },
  emptyText: {
    marginTop: 8,
    color: '#71807B',
    fontSize: 13,
    lineHeight: 19,
    textAlign: 'center',
  },
  reportList: {
    gap: 10,
  },
  reportCard: {
    padding: 15,
    borderWidth: 1,
    borderColor: '#E1E9E5',
    borderRadius: 14,
    backgroundColor: '#FFFFFF',
  },
  selectedReport: {
    borderColor: '#6A9B88',
  },
  reportTopLine: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 9,
  },
  reportDescription: {
    flex: 1,
    color: '#18332E',
    fontSize: 14,
    fontWeight: '700',
  },
  status: {
    overflow: 'hidden',
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 9,
    fontSize: 10,
    fontWeight: '700',
    textTransform: 'uppercase',
  },
  reportMeta: {
    marginTop: 9,
    color: '#71807B',
    fontSize: 11,
  },
  editHint: {
    marginTop: 7,
    color: '#397B68',
    fontSize: 11,
    fontWeight: '600',
  },
  reportError: {
    marginTop: 8,
    color: '#A73D35',
    fontSize: 12,
    lineHeight: 17,
  },
});

function errorMessage(error: unknown): string {
  return error instanceof Error
    ? error.message
    : 'An unexpected local storage error occurred.';
}

export default App;
