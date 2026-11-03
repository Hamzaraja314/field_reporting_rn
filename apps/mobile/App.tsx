import {
  SafeAreaProvider,
  SafeAreaView,
} from 'react-native-safe-area-context';
import { StatusBar, StyleSheet, Text, View } from 'react-native';

function App() {
  return (
    <SafeAreaProvider>
      <StatusBar barStyle="dark-content" />
      <SafeAreaView style={styles.safeArea}>
        <View style={styles.container}>
          <View style={styles.brand}>
            <View style={styles.brandMark}>
              <Text style={styles.brandMarkText}>F</Text>
            </View>
            <View>
              <Text style={styles.brandName}>FIELD REPORTING</Text>
              <Text style={styles.brandCaption}>MOBILE WORKSPACE</Text>
            </View>
          </View>

          <View style={styles.intro}>
            <Text style={styles.eyebrow}>FIELD OPERATIONS</Text>
            <Text style={styles.title}>Field Reporting</Text>
            <Text style={styles.subtitle}>
              Offline Field Report Management
            </Text>
          </View>

          <View style={styles.statusCard}>
            <View style={styles.statusHeading}>
              <View style={styles.statusDot} />
              <Text style={styles.statusLabel}>FOUNDATION READY</Text>
            </View>
            <Text style={styles.cardTitle}>Your mobile app is running.</Text>
            <Text style={styles.cardDescription}>
              The native application is ready for the next implementation
              milestone.
            </Text>
            <View style={styles.platformBadge}>
              <Text style={styles.platformText}>ANDROID APP</Text>
            </View>
          </View>

          <Text style={styles.footer}>
            Offline report workflows will be added in a later milestone.
          </Text>
        </View>
      </SafeAreaView>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: '#F4F6F5',
  },
  container: {
    flex: 1,
    paddingHorizontal: 24,
    paddingTop: 16,
    paddingBottom: 20,
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
    marginTop: 56,
  },
  eyebrow: {
    color: '#438272',
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 1.5,
  },
  title: {
    marginTop: 12,
    color: '#18332E',
    fontSize: 36,
    fontWeight: '700',
    letterSpacing: -1,
  },
  subtitle: {
    marginTop: 8,
    color: '#64736F',
    fontSize: 16,
    lineHeight: 24,
  },
  statusCard: {
    marginTop: 36,
    padding: 22,
    borderWidth: 1,
    borderColor: '#E1E9E5',
    borderRadius: 20,
    backgroundColor: '#FFFFFF',
  },
  statusHeading: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 9,
  },
  statusDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: '#3B9676',
  },
  statusLabel: {
    color: '#397B68',
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 1.2,
  },
  cardTitle: {
    marginTop: 20,
    color: '#18332E',
    fontSize: 21,
    fontWeight: '700',
    lineHeight: 29,
  },
  cardDescription: {
    marginTop: 8,
    color: '#64736F',
    fontSize: 14,
    lineHeight: 21,
  },
  platformBadge: {
    alignSelf: 'flex-start',
    marginTop: 20,
    paddingHorizontal: 11,
    paddingVertical: 7,
    borderRadius: 8,
    backgroundColor: '#EDF4F1',
  },
  platformText: {
    color: '#397B68',
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 0.8,
  },
  footer: {
    marginTop: 'auto',
    paddingTop: 28,
    color: '#7A8984',
    fontSize: 12,
    lineHeight: 18,
    textAlign: 'center',
  },
});

export default App;
