import { useEffect, useState } from "react";
import * as WebBrowser from "expo-web-browser";
import * as Google from "expo-auth-session/providers/google";
import AuthService from "../services/authService";

WebBrowser.maybeCompleteAuthSession();

const WEB_CLIENT_ID = "748747098609-6g76kbiqgap1nnmbgpskqo2votiihro2.apps.googleusercontent.com"; // paste your client ID

export function useGoogleAuth({ onSuccess, onError }) {
  const [loading, setLoading] = useState(false);

  const [request, response, promptAsync] = Google.useAuthRequest({
    clientId:    WEB_CLIENT_ID,
    scopes:      ["profile", "email"],
  });

  useEffect(() => {
    if (response?.type === "success") {
      handleGoogleResponse(response.authentication.accessToken);
    } else if (response?.type === "error") {
      setLoading(false);
      onError?.("Google sign-in failed. Please try again.");
    } else if (response?.type === "cancel" || response?.type === "dismiss") {
      setLoading(false);
    }
  }, [response]);

  const handleGoogleResponse = async (accessToken) => {
    try {
      // Fetch user info from Google
      const userInfoRes = await fetch("https://www.googleapis.com/userinfo/v2/me", {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      const googleUser = await userInfoRes.json();

      // Send to your backend
      const res = await fetch("http://localhost:5000/api/v1/auth/google", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({
          googleId:  googleUser.id,
          email:     googleUser.email,
          firstName: googleUser.given_name,
          lastName:  googleUser.family_name,
          picture:   googleUser.picture,
        }),
      });

      const data = await res.json();

      if (data.success) {
        // Save tokens
        await AuthService.saveTokens(data.data.accessToken, data.data.refreshToken);
        onSuccess?.();
      } else {
        onError?.(data.message || "Google login failed.");
      }
    } catch (err) {
      onError?.("Network error. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  const signInWithGoogle = async () => {
    setLoading(true);
    try {
      await promptAsync();
    } catch (err) {
      setLoading(false);
      onError?.("Failed to open Google sign-in.");
    }
  };

  return {
    signInWithGoogle,
    loading,
    ready: !!request,
  };
}