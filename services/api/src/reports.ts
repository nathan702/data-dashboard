import { randomUUID } from "node:crypto";
import type { Firestore } from "firebase-admin/firestore";
import {
  programFamilySettingsSchema,
  reportSpecSchema,
  type ProgramFamilySettings,
  type SavedReport,
  type SavedReportInput,
} from "@dash/shared";

/** Saved reports (Firestore "reports"): private to their owner unless shared. */
export interface ReportStore {
  list(): Promise<SavedReport[]>;
  get(id: string): Promise<SavedReport | null>;
  create(input: SavedReportInput, owner: string): Promise<SavedReport>;
  update(id: string, input: SavedReportInput): Promise<SavedReport>;
  delete(id: string): Promise<void>;
}

/** Program → family/branch overrides (Settings), in Firestore at config/programFamilies. */
export interface ProgramFamilyStore {
  get(): Promise<ProgramFamilySettings>;
  set(settings: ProgramFamilySettings, by: string): Promise<void>;
}

function fromDoc(id: string, d: Record<string, unknown>): SavedReport | null {
  const spec = reportSpecSchema.safeParse(d.spec);
  if (!spec.success) return null; // a field was retired; skip rather than break the list
  return {
    id,
    name: String(d.name ?? "Untitled"),
    description: String(d.description ?? ""),
    spec: spec.data,
    owner: (d.owner as string) ?? null,
    shared: !!d.shared,
    starter: false,
    updatedAt: (d.updatedAt as string) ?? null,
  };
}

export class FirestoreReports implements ReportStore {
  constructor(private readonly db: Firestore) {}
  private col() {
    return this.db.collection("reports");
  }
  async list() {
    const snap = await this.col().get();
    return snap.docs.map((d) => fromDoc(d.id, d.data())).filter((r): r is SavedReport => r !== null);
  }
  async get(id: string) {
    const d = await this.col().doc(id).get();
    return d.exists ? fromDoc(d.id, d.data()!) : null;
  }
  async create(input: SavedReportInput, owner: string) {
    const id = randomUUID().slice(0, 12);
    const doc = { ...input, owner, updatedAt: new Date().toISOString() };
    await this.col().doc(id).set(doc);
    return fromDoc(id, doc)!;
  }
  async update(id: string, input: SavedReportInput) {
    const doc = { ...input, updatedAt: new Date().toISOString() };
    await this.col().doc(id).set(doc, { merge: true });
    return (await this.get(id))!;
  }
  async delete(id: string) {
    await this.col().doc(id).delete();
  }
}

export class MemoryReports implements ReportStore {
  private readonly data = new Map<string, SavedReport>();
  async list() {
    return [...this.data.values()];
  }
  async get(id: string) {
    return this.data.get(id) ?? null;
  }
  async create(input: SavedReportInput, owner: string) {
    const r: SavedReport = { id: randomUUID().slice(0, 12), ...input, owner, starter: false, updatedAt: new Date().toISOString() };
    this.data.set(r.id, r);
    return r;
  }
  async update(id: string, input: SavedReportInput) {
    const r = { ...this.data.get(id)!, ...input, updatedAt: new Date().toISOString() };
    this.data.set(id, r);
    return r;
  }
  async delete(id: string) {
    this.data.delete(id);
  }
}

export class FirestoreProgramFamilies implements ProgramFamilyStore {
  private cache: { at: number; value: ProgramFamilySettings } | null = null;
  constructor(private readonly db: Firestore) {}
  private doc() {
    return this.db.collection("config").doc("programFamilies");
  }
  async get() {
    if (this.cache && Date.now() - this.cache.at < 60_000) return this.cache.value;
    const parsed = programFamilySettingsSchema.safeParse((await this.doc().get()).data()?.settings);
    const value = parsed.success ? parsed.data : { overrides: {} };
    this.cache = { at: Date.now(), value };
    return value;
  }
  async set(settings: ProgramFamilySettings, by: string) {
    await this.doc().set({ settings, updatedBy: by, updatedAt: new Date().toISOString() });
    this.cache = { at: Date.now(), value: settings };
  }
}

export class MemoryProgramFamilies implements ProgramFamilyStore {
  private value: ProgramFamilySettings = { overrides: {} };
  async get() {
    return this.value;
  }
  async set(settings: ProgramFamilySettings) {
    this.value = settings;
  }
}
