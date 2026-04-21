/**
 * CompleteProfileScreen.jsx
 * Drop into: screens/CompleteProfileScreen.jsx
 *
 * Shown to new Google sign-in users who need to set a phone number
 * and confirm/change their username before using the app.
 */

import { useState } from "react";
import {
  View, Text, TextInput, TouchableOpacity,
  StyleSheet, Alert, KeyboardAvoidingView,
  Platform, ScrollView, ActivityIndicator,
} from "react-native";
import AuthService from "../services/authService";

export default function CompleteProfileScreen({ navigation, route }) {
  const { user } = route.params || {};

  const [phone, setPhone] = useState("");
  const [username, setUsername] = useState(user?.username?.startsWith("user_") ? "" : user?.username || "");
  const [loading, setLoading] = useState(false);
  const [focusedField, setFocusedField] = useState(null);

  const focus = (f) => () => setFocusedField(f);
  const blur = () => setFocusedField(null);

  const handleComplete = async () => {
    if (!phone.trim()) {
      return Alert.alert("Phone Required", "Please enter your phone number.");
    }
    if (!username.trim() || username.length < 3) {
      return Alert.alert("Username Required", "Please enter a username (min. 3 characters).");
    }

    try {
      setLoading(true);
      const result = await AuthService.completeProfile({ phone: phone.trim(), username: username.trim() });

      if (result.success) {
        // Navigate to home — profile is complete
        navigation.replace("Home");
      } else {
        Alert.alert("Update Failed", result.message);
      }
    } catch (err) {
      Alert.alert("Error", err.message || "Failed to update profile.");
    } finally {
      setLoading(false);
    }
  };

  const handleSkip = () => {
    // Allow skipping — they can complete later in settings
    navigation.replace("Home");
  };

  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : "height"}>
      <ScrollView style={styles.container} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">

        {/* Avatar / greeting */}
        <View style={styles.avatarWrapper}>
          {user?.avatar ? (
            // If you have expo-image or Image available:
            <View style={styles.avatarPlaceholder}>
              <Text style={styles.avatarInitial}>
                {(user.firstName || "U")[0].toUpperCase()}
              </Text>
            </View>
          ) : (
            <View style={styles.avatarPlaceholder}>
              <Text style={styles.avatarInitial}>
                {(user?.firstName || "U")[0].toUpperCase()}
              </Text>
            </View>
          )}
          <View style={styles.googleBadge}>
            <Text style={styles.googleBadgeText}>G</Text>
          </View>
        </View>

        <Text style={styles.heading}>Almost there! 🎉</Text>
        <Text style={styles.subheading}>
          Hi {user?.firstName || "there"}! Just add a couple more details to complete your PromoEarn account.
        </Text>

        {/* Card */}
        <View style={styles.card}>

          {/* Username */}
          <View style={styles.fieldWrapper}>
            <Text style={styles.label}>Username *</Text>
            <View style={[styles.inputRow, focusedField === "username" && styles.inputFocused]}>
              <Text style={styles.inputIcon}>🏷️</Text>
              <TextInput
                style={styles.input}
                placeholder="Choose a username (min. 3 chars)"
                placeholderTextColor="#CBD5E1"
                value={username}
                onChangeText={setUsername}
                autoCapitalize="none"
                onFocus={focus("username")}
                onBlur={blur}
              />
            </View>
            <Text style={styles.hint}>Letters, numbers, and underscores only</Text>
          </View>

          {/* Phone */}
          <View style={styles.fieldWrapper}>
            <Text style={styles.label}>Phone Number *</Text>
            <View style={[styles.inputRow, focusedField === "phone" && styles.inputFocused]}>
              <Text style={styles.inputIcon}>📱</Text>
              <TextInput
                style={styles.input}
                placeholder="+234 800 000 0000"
                placeholderTextColor="#CBD5E1"
                value={phone}
                onChangeText={setPhone}
                keyboardType="phone-pad"
                onFocus={focus("phone")}
                onBlur={blur}
              />
            </View>
            <Text style={styles.hint}>Include your country code, e.g. +234...</Text>
          </View>

          {/* Email (read-only — from Google) */}
          <View style={styles.fieldWrapper}>
            <Text style={styles.label}>Email (from Google)</Text>
            <View style={[styles.inputRow, styles.inputReadOnly]}>
              <Text style={styles.inputIcon}>✉️</Text>
              <Text style={styles.readOnlyText}>{user?.email || "—"}</Text>
              <Text style={styles.verifiedBadge}>✓ Verified</Text>
            </View>
          </View>

          {/* Complete button */}
          <TouchableOpacity style={styles.ctaButton} onPress={handleComplete} disabled={loading} activeOpacity={0.85}>
            {loading
              ? <ActivityIndicator color="#fff" />
              : <Text style={styles.ctaText}>Complete Profile 🚀</Text>
            }
          </TouchableOpacity>

          {/* Skip */}
          <TouchableOpacity style={styles.skipBtn} onPress={handleSkip} activeOpacity={0.7}>
            <Text style={styles.skipText}>Skip for now — I'll do this later</Text>
          </TouchableOpacity>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const BLUE = "#1A56DB";
const DARK = "#0F172A";
const WHITE = "#FFFFFF";

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#F8FAFF" },
  content: { paddingHorizontal: 20, paddingTop: 60, paddingBottom: 48 },
  avatarWrapper: { alignSelf: "center", marginBottom: 20, position: "relative" },
  avatarPlaceholder: { width: 80, height: 80, borderRadius: 40, backgroundColor: BLUE, alignItems: "center", justifyContent: "center" },
  avatarInitial: { color: WHITE, fontSize: 32, fontWeight: "800" },
  googleBadge: { position: "absolute", bottom: 0, right: 0, width: 26, height: 26, borderRadius: 13, backgroundColor: WHITE, alignItems: "center", justifyContent: "center", borderWidth: 2, borderColor: "#E2E8F0" },
  googleBadgeText: { fontSize: 13, fontWeight: "800", color: "#4285F4" },
  heading: { fontSize: 26, fontWeight: "800", color: DARK, textAlign: "center", letterSpacing: -0.5, marginBottom: 8 },
  subheading: { fontSize: 14, color: "#64748B", textAlign: "center", lineHeight: 20, marginBottom: 28 },
  card: { backgroundColor: WHITE, borderRadius: 24, padding: 24, shadowColor: BLUE, shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.08, shadowRadius: 20, elevation: 6 },
  fieldWrapper: { marginBottom: 16 },
  label: { fontSize: 13, fontWeight: "600", color: "#475569", marginBottom: 6, letterSpacing: 0.3 },
  inputRow: { flexDirection: "row", alignItems: "center", backgroundColor: "#F8FAFF", borderRadius: 12, borderWidth: 1.5, borderColor: "#E2E8F0", paddingHorizontal: 14, height: 52 },
  inputFocused: { borderColor: BLUE, backgroundColor: "#EEF4FF" },
  inputReadOnly: { backgroundColor: "#F1F5F9", borderColor: "#E2E8F0" },
  inputIcon: { fontSize: 16, marginRight: 10 },
  input: { flex: 1, fontSize: 15, color: DARK, fontWeight: "500" },
  readOnlyText: { flex: 1, fontSize: 15, color: "#64748B" },
  verifiedBadge: { fontSize: 12, color: "#10B981", fontWeight: "700" },
  hint: { fontSize: 11, color: "#94A3B8", marginTop: 4 },
  ctaButton: { backgroundColor: BLUE, borderRadius: 14, height: 54, alignItems: "center", justifyContent: "center", marginTop: 8, shadowColor: BLUE, shadowOffset: { width: 0, height: 6 }, shadowOpacity: 0.35, shadowRadius: 14, elevation: 8 },
  ctaText: { color: WHITE, fontSize: 16, fontWeight: "700", letterSpacing: 0.4 },
  skipBtn: { alignItems: "center", marginTop: 16, padding: 8 },
  skipText: { fontSize: 13, color: "#94A3B8", fontWeight: "500" },
});
