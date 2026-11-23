import type { Firestore } from "firebase-admin/firestore";
import {
  cleanNotificationSettings,
  cleanPreferences,
  DEFAULT_NOTIFICATION_SETTINGS,
  DEFAULT_PREFERENCES,
  EMPTY_ALERT_STATE,
  notificationsOn,
  type AlertState,
  type BusinessLine,
  type NotificationSettings,
} from "@dash/shared";

/** A person who gets notifications: their sign-in email, choices and tabs (the default lines). */
export interface Subscriber {
  email: string;
  settings: NotificationSettings;
  tabs: BusinessLine[];
}

/**
 * Each person's notification choices, kept with their tab order in Firestore
 * users/{sign-in email}. Staff sign-in addresses only (agreed); nothing goes to BigQuery.
 */
export interface NotificationStore {
  get(email: string): Promise<NotificationSettings>;
  set(email: string, settings: NotificationSettings): Promise<void>;
  /** Everyone with Slack or email switched on. */
  subscribers(): Promise<Subscriber[]>;
}

export class FirestoreNotifications implements NotificationStore {
  constructor(private readonly db: Firestore) {}
  private doc(email: string) {
    return this.db.collection("users").doc(email.toLowerCase());
  }
  async get(email: string) {
    const d = (await this.doc(email).get()).data();
    return d?.notifications ? cleanNotificationSettings(d.notifications) : DEFAULT_NOTIFICATION_SETTINGS;
  }
  async set(email: string, settings: NotificationSettings) {
    await this.doc(email).set({ notifications: settings, updatedAt: new Date().toISOString() }, { merge: true });
  }
  async subscribers() {
    const snap = await this.db.collection("users").get();
    return snap.docs.flatMap((d) => {
      const data = d.data();
      if (!data.notifications) return [];
      const settings = cleanNotificationSettings(data.notifications);
      if (!notificationsOn(settings)) return [];
      return [{ email: d.id, settings, tabs: (data.preferences ? cleanPreferences(data.preferences) : DEFAULT_PREFERENCES).tabs }];
    });
  }
}

export class MemoryNotifications implements NotificationStore {
  readonly data = new Map<string, NotificationSettings>();
  constructor(private readonly tabs: (email: string) => BusinessLine[] = () => DEFAULT_PREFERENCES.tabs) {}
  async get(email: string) {
    return this.data.get(email.toLowerCase()) ?? DEFAULT_NOTIFICATION_SETTINGS;
  }
  async set(email: string, settings: NotificationSettings) {
    this.data.set(email.toLowerCase(), settings);
  }
  async subscribers() {
    return [...this.data].filter(([, s]) => notificationsOn(s)).map(([email, settings]) => ({ email, settings, tabs: this.tabs(email) }));
  }
}

/** What the alerts last saw (Firestore notifications/state), so each fires once per change. */
export interface AlertStateStore {
  get(): Promise<AlertState>;
  set(state: AlertState): Promise<void>;
}

export class FirestoreAlertState implements AlertStateStore {
  constructor(private readonly db: Firestore) {}
  private doc() {
    return this.db.collection("notifications").doc("state");
  }
  async get() {
    const d = (await this.doc().get()).data();
    return d?.state ? { ...EMPTY_ALERT_STATE, ...(d.state as Partial<AlertState>) } : EMPTY_ALERT_STATE;
  }
  async set(state: AlertState) {
    await this.doc().set({ state, updatedAt: new Date().toISOString() });
  }
}

export class MemoryAlertState implements AlertStateStore {
  state: AlertState = EMPTY_ALERT_STATE;
  async get() {
    return this.state;
  }
  async set(state: AlertState) {
    this.state = state;
  }
}
