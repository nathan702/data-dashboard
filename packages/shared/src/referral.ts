/**
 * "How did you hear about us?" Campminder asks it as a dropdown (these
 * choices) with an optional box to add text. Only the choice is kept: the
 * added text can name a person ("Current Camper Family — the Smiths"), so the
 * import never stores it. An answer that isn't one of the choices is "Other".
 */
export const HEARD_ABOUT_CHOICES = ["Facebook", "Instagram", "Current Camper Family", "Current Staff Member", "Web Search"] as const;
export const HEARD_ABOUT_OTHER = "Other";
export type HeardAbout = (typeof HEARD_ABOUT_CHOICES)[number] | typeof HEARD_ABOUT_OTHER;

const squash = (s: string) => s.toLowerCase().replace(/[^a-z]+/g, " ").trim();

/**
 * The choice an answer starts with (the dropdown's text comes first, any added
 * text after it), else "Other"; blank or "N/A" answers are null. Nothing typed
 * is ever returned.
 */
export function heardAboutChoice(answer: string | null | undefined): HeardAbout | null {
  const a = squash(answer ?? "");
  if (!a || a === "n a" || a === "na" || a === "none") return null;
  for (const choice of HEARD_ABOUT_CHOICES) {
    const c = squash(choice);
    if (a === c || a.startsWith(`${c} `)) return choice;
  }
  // The choice may come after a label or in other words ("Search engine", "a staff member").
  for (const choice of HEARD_ABOUT_CHOICES) if (a.includes(squash(choice))) return choice;
  return HEARD_ABOUT_OTHER;
}

/** The report column with the answer: any "How did you hear…" or "Referral…" header. */
export function heardAboutColumn(headers: Iterable<string>): string | null {
  for (const h of headers) if (/\bhow\s+did\s+you\s+hear\b|\bhear\s+about\b|\breferr(al|ed)\b/i.test(h)) return h;
  return null;
}

/** New or returning to a business line (Camp: a household's first Camp season). */
export const NEW_FAMILY = "New family";
export const RETURNING_FAMILY = "Returning family";
