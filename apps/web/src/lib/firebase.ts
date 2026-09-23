import { initializeApp, type FirebaseApp } from "firebase/app";
import { getAuth, GoogleAuthProvider, type Auth } from "firebase/auth";

export const authDisabled = import.meta.env.VITE_AUTH_DISABLED === "1";
export const workspaceDomain = import.meta.env.VITE_GOOGLE_WORKSPACE_DOMAIN as string | undefined;

let app: FirebaseApp | null = null;
let auth: Auth | null = null;

export function firebaseAuth(): Auth {
  if (!auth) {
    app = initializeApp({
      apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
      authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
      projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
      appId: import.meta.env.VITE_FIREBASE_APP_ID,
    });
    auth = getAuth(app);
  }
  return auth;
}

export function googleProvider(): GoogleAuthProvider {
  const provider = new GoogleAuthProvider();
  // Only offer accounts from the organization's Workspace. The API enforces
  // this too; this just keeps people from picking a personal account.
  if (workspaceDomain) provider.setCustomParameters({ hd: workspaceDomain, prompt: "select_account" });
  return provider;
}
