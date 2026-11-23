import { useState } from "react";
import {
  BUSINESS_LINE_INFO,
  BUSINESS_LINES,
  DIGEST_HOURS,
  type BusinessLine,
  type DailyMode,
  type NotificationSettings,
} from "@dash/shared";
import { useMe, useMyNotifications, useSaveMyNotifications, useSendTestNotification } from "../lib/api";
import { useTabs } from "../lib/tabs";

const DAILY_LABEL: Record<DailyMode, string> = { off: "Off", weekdays: "Weekdays (Mon–Fri)", every_day: "Every day" };
const hourLabel = (h: number) => `${h}:00am`;
const TEST_RESULT: Record<string, string> = {
  sent: "Sent. Check your Slack direct messages.",
  no_slack_user: "Slack has no account with your sign-in email. Ask a Slack admin to check it matches.",
  not_configured: "Slack isn't set up for the dashboard yet.",
  failed: "Slack didn't accept the message. Try again in a minute; if it keeps failing, tell an admin.",
};

function Check({ label, checked, disabled, onChange, hint }: { label: string; checked: boolean; disabled?: boolean; onChange(v: boolean): void; hint?: string }) {
  return (
    <label className="checkbox notif-check">
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span>
        {label}
        {hint && <span className="hint"> · {hint}</span>}
      </span>
    </label>
  );
}

/**
 * My notifications: each person chooses their own digests and alerts, and
 * where they arrive. Totals only; the same numbers as the dashboard.
 */
export function MyNotifications() {
  const { data, error } = useMyNotifications();
  const save = useSaveMyNotifications();
  const test = useSendTestNotification();
  const me = useMe();
  const tabs = useTabs();
  const [draft, setDraft] = useState<NotificationSettings | null>(null);
  const [saved, setSaved] = useState(false);
  if (error) return <div className="error-banner">Couldn't load your notifications: {error.message}</div>;
  if (!data) return null;
  const s = draft ?? data.settings;
  const dirty = draft !== null && JSON.stringify(draft) !== JSON.stringify(data.settings);
  const set = (patch: Partial<NotificationSettings>) => {
    setDraft({ ...s, ...patch });
    setSaved(false);
  };
  const setAlerts = (patch: Partial<NotificationSettings["alerts"]>) => set({ alerts: { ...s.alerts, ...patch } });
  const lines = s.lines ?? tabs;
  const toggleLine = (l: BusinessLine, on: boolean) => {
    const next = on ? [...lines, l] : lines.filter((x) => x !== l);
    set({ lines: BUSINESS_LINES.filter((x) => next.includes(x)) });
  };
  const nothingOn = !s.slack && !s.email;

  return (
    <div className="page">
      <header className="page-header">
        <h1>My notifications</h1>
      </header>
      <p className="muted" style={{ margin: 0 }}>
        Your own digests and alerts: totals only, the same numbers as the dashboard. Nobody else sees or changes these.
      </p>

      <section className="card">
        <h2 className="card-title">Where to send</h2>
        <p className="card-subtitle">A direct message from the dashboard's Slack app, found by your sign-in email.</p>
        <Check
          label="Slack direct message"
          checked={s.slack}
          onChange={(v) => set({ slack: v })}
          hint={data.slackConfigured ? undefined : "Slack isn't set up for the dashboard yet; your choices are kept for when it is"}
        />
        <Check label="Email" checked={s.email} disabled onChange={(v) => set({ email: v })} hint="coming in the next update" />
      </section>

      <section className="card">
        <h2 className="card-title">Digests</h2>
        <p className="card-subtitle">
          What was booked (net) per line against the same day last year, your lines' targets, Camp and School Year sign-ups, and whether data is up to date.
        </p>
        <div className="filter-bar">
          <label className="field">
            <span className="field-label">Daily (yesterday)</span>
            <select value={s.daily} onChange={(e) => set({ daily: e.target.value as DailyMode })}>
              {(Object.keys(DAILY_LABEL) as DailyMode[]).map((d) => (
                <option key={d} value={d}>
                  {DAILY_LABEL[d]}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span className="field-label">Weekly (Monday, last week)</span>
            <select value={s.weekly ? "on" : "off"} onChange={(e) => set({ weekly: e.target.value === "on" })}>
              <option value="off">Off</option>
              <option value="on">On (replaces Monday's daily)</option>
            </select>
          </label>
          <label className="field">
            <span className="field-label">Arrives at (Eastern)</span>
            <select value={s.hour} onChange={(e) => set({ hour: Number(e.target.value) as NotificationSettings["hour"] })}>
              {DIGEST_HOURS.map((h) => (
                <option key={h} value={h}>
                  {hourLabel(h)}
                </option>
              ))}
            </select>
          </label>
        </div>
      </section>

      <section className="card">
        <h2 className="card-title">Alerts</h2>
        <p className="card-subtitle">Sent within the hour, once per change.</p>
        <Check label="A target falls behind pace, and when it recovers" checked={s.alerts.targetBehind} onChange={(v) => setAlerts({ targetBehind: v })} />
        <div className="notif-row">
          <Check label="A big day: yesterday's bookings were at least" checked={s.alerts.bigDay} onChange={(v) => setAlerts({ bigDay: v })} />
          <input
            className="notif-percent"
            type="number"
            min={10}
            max={500}
            step={5}
            value={s.alerts.bigDayPercent}
            aria-label="Big day threshold, percent"
            onChange={(e) => setAlerts({ bigDayPercent: Math.max(10, Math.min(500, Math.round(Number(e.target.value) || 50))) })}
          />
          <span className="muted">% above or below the same day last year</span>
        </div>
        {me.data?.isAdmin && (
          <>
            <Check label="A platform stops syncing, and when it's back" checked={s.alerts.syncStale} onChange={(v) => setAlerts({ syncStale: v })} hint="admins" />
            <Check label="Revenue arrives that isn't assigned to a business line" checked={s.alerts.unassigned} onChange={(v) => setAlerts({ unassigned: v })} hint="admins" />
          </>
        )}
      </section>

      <section className="card">
        <h2 className="card-title">Business lines</h2>
        <p className="card-subtitle">{s.lines === null ? "Following your tabs. Change any to choose your own." : "Digests and line alerts cover these lines."}</p>
        <div className="notif-lines">
          {BUSINESS_LINES.map((l) => (
            <Check key={l} label={BUSINESS_LINE_INFO[l].label} checked={lines.includes(l)} onChange={(v) => toggleLine(l, v)} />
          ))}
        </div>
        {s.lines !== null && (
          <button type="button" className="link-button" onClick={() => set({ lines: null })}>
            Follow my tabs again
          </button>
        )}
      </section>

      <div className="notif-actions">
        {saved && !dirty && <span className="hint">✓ Saved</span>}
        {dirty && (
          <button type="button" className="button" onClick={() => setDraft(null)}>
            Undo changes
          </button>
        )}
        <button
          type="button"
          className="button button-primary"
          disabled={!dirty || save.isPending}
          onClick={() =>
            void save.mutateAsync(s).then(() => {
              setDraft(null);
              setSaved(true);
            })
          }
        >
          {save.isPending ? "Saving…" : dirty ? "Save" : "No changes"}
        </button>
        <button type="button" className="button" disabled={!data.slackConfigured || test.isPending || dirty} onClick={() => test.mutate()} title={dirty ? "Save first" : undefined}>
          {test.isPending ? "Sending…" : "Send me a test"}
        </button>
        {test.data && <span className="hint">{TEST_RESULT[test.data] ?? `Couldn't send (${test.data}).`}</span>}
        {nothingOn && !dirty && <span className="hint">Nothing is sent until you choose where to send.</span>}
      </div>
      {save.error && <div className="error-banner">Couldn't save: {save.error.message}</div>}
    </div>
  );
}
