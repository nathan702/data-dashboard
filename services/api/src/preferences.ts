import type { Firestore } from "firebase-admin/firestore";
import { cleanPreferences, DEFAULT_PREFERENCES, type Preferences } from "@dash/shared";

/** Per-person settings (tab order), keyed by email. */
export interface PreferencesStore {
  get(email: string): Promise<Preferences>;
  set(email: string, prefs: Preferences): Promise<void>;
}

export class FirestorePreferences implements PreferencesStore {
  constructor(private readonly db: Firestore) {}
  private doc(email: string) {
    return this.db.collection("users").doc(email.toLowerCase());
  }
  async get(email: string) {
    const d = (await this.doc(email).get()).data();
    return d?.preferences ? cleanPreferences(d.preferences) : DEFAULT_PREFERENCES;
  }
  async set(email: string, prefs: Preferences) {
    await this.doc(email).set({ preferences: prefs, updatedAt: new Date().toISOString() }, { merge: true });
  }
}

export class MemoryPreferences implements PreferencesStore {
  private readonly data = new Map<string, Preferences>();
  async get(email: string) {
    return this.data.get(email) ?? DEFAULT_PREFERENCES;
  }
  async set(email: string, prefs: Preferences) {
    this.data.set(email, prefs);
  }
}
