import type { Firestore } from "firebase-admin/firestore";
import { cleanSeasonSettings, DEFAULT_SEASON_SETTINGS, type SeasonSettings } from "@dash/shared";

/** Season rules per business line (Settings page), in Firestore at config/seasons. */
export interface SeasonSettingsStore {
  get(): Promise<SeasonSettings>;
  set(settings: SeasonSettings, by: string): Promise<void>;
}

export class FirestoreSeasonSettings implements SeasonSettingsStore {
  private cache: { at: number; value: SeasonSettings } | null = null;
  constructor(private readonly db: Firestore) {}
  private doc() {
    return this.db.collection("config").doc("seasons");
  }
  async get() {
    if (this.cache && Date.now() - this.cache.at < 60_000) return this.cache.value;
    const d = (await this.doc().get()).data();
    const value = d?.settings ? cleanSeasonSettings(d.settings) : DEFAULT_SEASON_SETTINGS;
    this.cache = { at: Date.now(), value };
    return value;
  }
  async set(settings: SeasonSettings, by: string) {
    await this.doc().set({ settings, updatedBy: by, updatedAt: new Date().toISOString() });
    this.cache = { at: Date.now(), value: settings };
  }
}

export class MemorySeasonSettings implements SeasonSettingsStore {
  private value: SeasonSettings = DEFAULT_SEASON_SETTINGS;
  async get() {
    return this.value;
  }
  async set(settings: SeasonSettings) {
    this.value = settings;
  }
}
