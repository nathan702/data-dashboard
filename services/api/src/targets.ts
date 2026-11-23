import type { Firestore } from "firebase-admin/firestore";
import { cleanTargetSettings, EMPTY_TARGET_SETTINGS, type TargetSettings } from "@dash/shared";

/** Targets per season, business line and measure (Settings → Targets), in Firestore at config/targets. */
export interface TargetStore {
  get(): Promise<TargetSettings>;
  set(settings: TargetSettings, by: string): Promise<void>;
}

export class FirestoreTargets implements TargetStore {
  private cache: { at: number; value: TargetSettings } | null = null;
  constructor(private readonly db: Firestore) {}
  private doc() {
    return this.db.collection("config").doc("targets");
  }
  async get() {
    if (this.cache && Date.now() - this.cache.at < 60_000) return this.cache.value;
    const d = (await this.doc().get()).data();
    const value = d?.settings ? cleanTargetSettings(d.settings) : EMPTY_TARGET_SETTINGS;
    this.cache = { at: Date.now(), value };
    return value;
  }
  async set(settings: TargetSettings, by: string) {
    await this.doc().set({ settings, updatedBy: by, updatedAt: new Date().toISOString() });
    this.cache = { at: Date.now(), value: settings };
  }
}

export class MemoryTargets implements TargetStore {
  constructor(private value: TargetSettings = EMPTY_TARGET_SETTINGS) {}
  async get() {
    return this.value;
  }
  async set(settings: TargetSettings) {
    this.value = settings;
  }
}
