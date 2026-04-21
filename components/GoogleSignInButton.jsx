/**
 * GoogleSignInButton.jsx
 * Drop into: components/GoogleSignInButton.jsx
 *
 * A ready-to-use Google Sign-In button.
 * Handles the entire OAuth flow internally.
 *
 * Usage:
 *   <GoogleSignInButton
 *     onSuccess={(data) => navigation.navigate('Home')}
 *     onError={(msg) => Alert.alert('Error', msg)}
 *   />
 */

import { TouchableOpacity, Text, View, ActivityIndicator, StyleSheet, Alert } from "react-native";
import { useGoogleAuth } from "../hooks/useGoogleAuth";

export default function GoogleSignInButton({ onSuccess, onError, style, label = "Continue with Google" }) {
  const { signInWithGoogle, loading, ready } = useGoogleAuth({
    onSuccess,
    onError: (msg) => {
      onError?.(msg);
      Alert.alert("Google Sign-In Failed", msg);
    },
  });

  return (
    <TouchableOpacity
      style={[styles.button, (!ready || loading) && styles.buttonDisabled, style]}
      onPress={signInWithGoogle}
      disabled={!ready || loading}
      activeOpacity={0.85}
    >
      {loading ? (
        <ActivityIndicator size="small" color="#4285F4" />
      ) : (
        <>
          {/* Google "G" Logo */}
          <View style={styles.logoWrapper}>
            <Text style={styles.logo}>G</Text>
          </View>
          <Text style={styles.label}>{label}</Text>
        </>
      )}
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  button: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#FFFFFF",
    borderRadius: 14,
    height: 52,
    borderWidth: 1.5,
    borderColor: "#E2E8F0",
    gap: 10,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.04,
    shadowRadius: 8,
    elevation: 2,
  },
  buttonDisabled: {
    opacity: 0.6,
  },
  logoWrapper: {
    width: 24,
    height: 24,
    alignItems: "center",
    justifyContent: "center",
  },
  logo: {
    fontSize: 18,
    fontWeight: "800",
    color: "#4285F4",
  },
  label: {
    fontSize: 15,
    fontWeight: "600",
    color: "#334155",
  },
});
