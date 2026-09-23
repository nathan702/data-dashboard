import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { onIdTokenChanged, signInWithPopup, signOut, type User } from "firebase/auth";
import { authDisabled, firebaseAuth, googleProvider } from "./firebase";

interface AuthState {
  status: "loading" | "signed_out" | "signed_in";
  user: { email: string; name: string | null; photoUrl: string | null } | null;
  getToken(): Promise<string | null>;
  signIn(): Promise<void>;
  signOut(): Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

const devState: AuthState = {
  status: "signed_in",
  user: { email: "dev@localhost", name: "Local developer", photoUrl: null },
  getToken: async () => null,
  signIn: async () => {},
  signOut: async () => {},
};

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null | undefined>(authDisabled ? null : undefined);

  useEffect(() => {
    if (authDisabled) return;
    return onIdTokenChanged(firebaseAuth(), setUser);
  }, []);

  if (authDisabled) return <AuthContext.Provider value={devState}>{children}</AuthContext.Provider>;

  const value: AuthState = {
    status: user === undefined ? "loading" : user ? "signed_in" : "signed_out",
    user: user ? { email: user.email ?? "", name: user.displayName, photoUrl: user.photoURL } : null,
    getToken: async () => (firebaseAuth().currentUser ? firebaseAuth().currentUser!.getIdToken() : null),
    signIn: async () => {
      await signInWithPopup(firebaseAuth(), googleProvider());
    },
    signOut: () => signOut(firebaseAuth()),
  };
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside AuthProvider");
  return ctx;
}
