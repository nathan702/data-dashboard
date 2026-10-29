/**
 * Fuzzy school matching. Families type their school's name however they
 * like: typos ("Bannockbrun"), sound-alikes ("Beauvier" for Beauvoir), extra
 * or missing words ("Pyle" for Thomas W. Pyle Middle School, "Arlington
 * Montessori House"), abbreviations ("ASFS", "GDS"), run-together words
 * ("Woodacres"), district or place tags ("Murch (DCPS)", "Discovery
 * Elementary Arlington VA") and the odd answer that names two schools
 * ("Pyle/Whitman").
 *
 * Each answer is reduced to the words that identify a school, then scored
 * against every known school (official, created in Settings, or proposed from
 * the answers themselves). Distinctive words count for more than common ones
 * ("Pyle" matters; "Saint" or "Day" barely), so "Arlington Montessori" never
 * matches "Arlington Traditional" just because both say Arlington. The
 * confidence also weighs how clearly the best school beats the next: a typo
 * with nothing else close is a confident match, while "Key" with two Key
 * schools nearby goes to review.
 */

export type SchoolLevel = "elementary" | "middle" | "high" | "";

export interface ParsedSchool {
  /** What the family typed. */
  entered: string;
  /** Identifying words, normalized ("saint", "mount"; "school" and filler words removed). */
  tokens: string[];
  /** Level when the name gives one ("Pyle MS" → middle). */
  level: SchoolLevel;
  /** Tokens run together, so "Wood Acres" = "Woodacres". */
  joined: string;
  /** Names more than one school, or a future one ("Pyle/Whitman", "Taylor now/Hamm for 6th grade"): always reviewed. */
  multi: boolean;
  /** Says "The … School" without a level, the way private schools are named. */
  named: boolean;
  /** The level is in the name itself ("Flint Hill Elementary"), not just known from the official record. */
  levelInName: boolean;
  /** How many trailing tokens are places the family added ("Discovery Elementary Arlington VA"). */
  trailingPlaces: number;
}

/** Abbreviations and common spellings → the word they stand for. */
const WORDS: Record<string, string> = {
  st: "saint",
  ste: "saint",
  mt: "mount",
  ft: "fort",
  intl: "international",
  indep: "independent",
  acad: "academy",
  ctr: "center",
  centre: "center",
  highschool: "high",
  jr: "junior",
  sr: "senior",
  prek: "preschool",
  preschool: "preschool",
};

/** Level words and their abbreviations, as whole words. */
const LEVEL_WORDS: Record<string, SchoolLevel> = {
  elementary: "elementary",
  elem: "elementary",
  ele: "elementary",
  elm: "elementary",
  es: "elementary",
  middle: "middle",
  ms: "middle",
  high: "high",
  hs: "high",
};

/** Words that never tell schools apart. */
const FILLER = new Set(["the", "of", "and", "at", "for", "a", "in", "school", "schools"]);

/** District and charter tags families add ("Murch (DCPS)", "Mundo Verde PCS"). */
const TAGS = new Set(["dcps", "dspc", "aps", "mcps", "fcps", "pcs", "lcps", "public", "charter"]);

/**
 * Words many school names share, which say little about which school it is
 * ("Arlington Science Focus Center" is still Science Focus). Preschool words
 * aren't here: "Bannockburn Nursery School" is a different school from
 * Bannockburn Elementary.
 */
const GENERIC = new Set([
  "center", "house", "academy", "day", "prep", "preparatory", "learning", "campus", "institute", "program", "community",
  "country", "lower", "upper", "primary", "intermediate", "magnet", "junior", "senior", "college", "independent", "studio",
]);

/** Words for a preschool: a different school from an elementary of the same name, but just a word otherwise ("NCRC Preschool"). */
const PRESCHOOL = new Set(["preschool", "nursery", "kindergarten", "daycare", "childcare", "toddler", "infant"]);

/** Countries and the like, which answer where a camper lives rather than which school. */
const COUNTRIES = new Set([
  "germany", "france", "england", "uk", "canada", "mexico", "australia", "austria", "italy", "spain", "japan", "china", "india",
  "israel", "netherland", "switzerland", "sweden", "ireland", "brazil", "colombia", "argentina", "korea", "singapore", "overseas",
  "abroad", "europe", "international",
]);

/** Places families add to a school's name; they don't count against a match. */
const PLACES = new Set([
  "dc", "washington", "md", "maryland", "va", "virginia", "arlington", "bethesda", "potomac", "mclean", "rockville", "fairfax",
  "alexandria", "kensington", "vienna", "reston", "herndon", "germantown", "gaithersburg", "montgomery", "county", "nw",
]);

/** Edit distance allowing a swap of two neighboring letters (Damerau–Levenshtein, optimal string alignment). */
export function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array<number>(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0]![j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, d[i - 2]![j - 2]! + 1);
      d[i]![j] = v;
    }
  }
  return d[a.length]![b.length]!;
}

const near = (a: string, b: string, max: number) => Math.abs(a.length - b.length) <= max && editDistance(a, b) <= max;

/** A level word, abbreviated or misspelled ("Elementry", "Elemenatrary", "Midlle"). */
function levelOf(w: string): SchoolLevel | null {
  if (w in LEVEL_WORDS) return LEVEL_WORDS[w]!;
  if (w.length >= 6 && (w.startsWith("ele") || w.startsWith("elm")) && near(w, "elementary", 3)) return "elementary";
  if (w.length >= 5 && w.startsWith("mi") && near(w, "middle", 1)) return "middle";
  return null;
}

/** "School", misspelled ("Schoool", "Schol", "Achool", "Schoolk"). */
const isSchoolWord = (w: string) => w.length >= 5 && w.length <= 8 && near(w, "school", 1);

/** Plural → singular ("Arts" = "Art"), keeping "Lewis", "Holy Cross", "Campus". */
const singular = (w: string) => (w.length > 3 && w.endsWith("s") && !/(ss|us|is)$/.test(w) ? w.slice(0, -1) : w);

/** Phrases that mean the answer names more than one school, or a future one. */
const MULTI = /\s*(?:\/|;|->|→|\bnow\b|\bnext year\b|\bin the fall\b|\bwill enter\b|\bfor \d+(?:st|nd|rd|th) grade\b)\s*/i;

/** Reduce an answer to the words that identify a school; null when nothing is left. */
export function parseSchool(entered: string): ParsedSchool | null {
  let s = entered
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/\([^)]*\)/g, " ") // "(DCPS)", "(Houston Texas)"
    .replace(/['’`]/g, "");
  // A comma usually starts a place ("Bancroft Elementary, DC"); a tiny first part is a typo ("St, Patricks").
  const comma = s.indexOf(",");
  if (comma >= 0) s = comma <= 3 ? s.replace(",", " ") : s.slice(0, comma);
  const multi = MULTI.test(s);
  if (multi) s = s.split(MULTI)[0]!;

  const raw = s
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/\bdistrict of columbia\b/g, "dc")
    .replace(/\bhome[\s-]*school(?:ed|ing|er)?\b/g, "homeschool")
    .replace(/\bpre[\s-]*k\b|\bpre[\s-]+school\b/g, "preschool")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean)
    .map((w) => WORDS[w] ?? w);

  let level: SchoolLevel = "";
  const tokens: string[] = [];
  const named = /^\s*the\b|\bschool\b/i.test(s);
  raw.forEach((w, i) => {
    const lv = levelOf(w);
    // "High" first is a name ("High Point"); a lone "e" at the end is "Elementary" ("Kent Garden E").
    if (lv && !(w === "high" && i === 0 && raw.length > 1)) {
      level = lv;
      return;
    }
    if (w === "e" && i === raw.length - 1 && i > 0) {
      level = "elementary";
      return;
    }
    if (FILLER.has(w) || TAGS.has(w) || isSchoolWord(w)) return;
    tokens.push(singular(w));
  });
  // "Germany", "Overseas": where the family lives, not a school.
  if (tokens.length === 0 || (tokens.length === 1 && COUNTRIES.has(tokens[0]!))) return null;
  const joined = tokens.join("").replace(/school$/, "");
  let trailingPlaces = 0;
  while (trailingPlaces < tokens.length - 1 && PLACES.has(tokens[tokens.length - 1 - trailingPlaces]!)) trailingPlaces++;
  return { entered, tokens, level, joined, multi, named: named && !level, levelInName: !!level, trailingPlaces };
}

/** How much each word identifies a school: rare words weigh more (inverse document frequency over the known schools). */
export class WordWeights {
  private readonly df = new Map<string, number>();
  private n = 0;
  constructor(names: Iterable<string[]>) {
    for (const tokens of names) {
      this.n++;
      for (const t of new Set(tokens)) this.df.set(t, (this.df.get(t) ?? 0) + 1);
    }
  }
  /** How many school names have this word. */
  count(t: string): number {
    return this.df.get(t) ?? 0;
  }

  weight(t: string): number {
    // Initials ("Thomas W. Pyle") and generic words say little; unseen words are as distinctive as the rarest.
    if (t.length === 1) return 0.5;
    const idf = Math.max(0.25, Math.log((this.n + 1) / ((this.df.get(t) ?? 0) + 0.5)));
    return GENERIC.has(t) ? Math.min(idf, 1) : idf;
  }
}

/** How well one word matches another: exact 1, one typo 0.9, two typos in a long word 0.8, an abbreviation 0.75. */
export function wordMatch(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length === 1 || b.length === 1) return a[0] === b[0] ? 0.5 : 0; // an initial ("Thomas W Pyle")
  const len = Math.min(a.length, b.length);
  // People rarely mistype a word's first letter, so a short word with a different one is a different name (Lowell, Powell).
  const sameStart = a[0] === b[0];
  // A typo in a long word is a typo; in a short one it may be another name (Stokes, Stone).
  if (len >= 8 && near(a, b, 1)) return 0.9;
  if (len >= 5 && sameStart && near(a, b, 1)) return 0.85;
  if (len === 4 && sameStart && near(a, b, 1)) return 0.8;
  if (len >= 7 && sameStart && near(a, b, 2)) return 0.8;
  // A dropped vowel in a short word ("Hlls" for "Hills"), not just any letter (LAMB is not Lab).
  if (len === 3 && a.length !== b.length) {
    const [short, long] = a.length < b.length ? [a, b] : [b, a];
    if (long.length === 4 && [...long].some((ch, i) => "aeiouy".includes(ch) && long.slice(0, i) + long.slice(i + 1) === short)) return 0.85;
  }
  if (len >= 3 && (b.startsWith(a) || a.startsWith(b))) return 0.75;
  return 0;
}

/** How an answer fits one name of a school. */
export interface NameFit {
  /** 0–1. */
  score: number;
  /** Same words exactly (allowing run-together words). */
  exact: boolean;
  /** "The X School" against an official X Elementary, or the reverse: maybe a different school. */
  clash: boolean;
  /** Matched only with a misspelled word somewhere. */
  typo: boolean;
}

/**
 * How well an answer fits one name of a school. Matching words count by how
 * distinctive they are; words in the answer that aren't in the name
 * ("Arlington Science Focus *Center*") count against it, and words of the
 * name the answer leaves out ("*Thomas W.* Pyle") count a sixth as much,
 * since families shorten names far more than they add to them. A first name
 * the official list leaves off ("*Alice* Deal" for Deal MS) counts little,
 * places tacked on at the end ("… Arlington VA") don't count, and different
 * levels (Lowell Middle vs Lowell High) rule a match out.
 *
 * `lenientPreschool`: "NCRC Preschool" fits "NCRC" (comparing answers with
 * each other); against official schools a preschool word counts fully, since
 * a nursery school is a different school from the elementary of that name.
 */
export function nameFit(e: ParsedSchool, n: ParsedSchool, w: WordWeights, lenientPreschool = false): NameFit {
  const none = { score: 0, exact: false, clash: false, typo: false };
  if (e.level && n.level && e.level !== n.level) return none;
  // "The Potomac School" leans to the private school over Potomac Elementary, and "Potomac Elementary" the other way.
  // (Only a level in the name counts: Arlington Science Focus School is an elementary school by record, not by name.)
  const clash = !!((e.named && n.levelInName) || (e.levelInName && n.named));
  const levelFit = clash ? 0.9 : 1;
  // Exact: the same words, and the same level if either name gives one ("Whitman" isn't exactly Whitman Middle).
  if (e.joined === n.joined) return { score: levelFit, exact: e.levelInName === n.levelInName, clash, typo: false };
  // Run-together words: "Woodacres" vs "Wood Acres", "YuYing" vs "Yu Ying".
  if (e.tokens.length !== n.tokens.length && e.joined.length >= 7 && near(e.joined, n.joined, e.joined.length >= 12 ? 2 : 1)) {
    return { score: 0.92 * levelFit, exact: false, clash, typo: true };
  }

  const used = new Set<number>();
  const fits = e.tokens.map((t) => {
    let best = 0;
    let at = -1;
    n.tokens.forEach((u, i) => {
      if (used.has(i)) return;
      const m = wordMatch(t, u);
      if (m > best) [best, at] = [m, i];
    });
    if (at >= 0) used.add(at);
    return best;
  });
  const firstMatch = fits.findIndex((f) => f > 0);
  if (firstMatch < 0) return none;
  let matched = 0;
  let extra = 0;
  e.tokens.forEach((t, k) => {
    const best = fits[k]!;
    if (best === 0 && k >= e.tokens.length - e.trailingPlaces) return;
    let tw = w.weight(t);
    // Up to two leading words the name doesn't have: usually a first name the official list leaves off
    // (a place there is part of the name: "Bethesda Montessori").
    if (best === 0 && k < firstMatch && firstMatch <= 2 && !PLACES.has(t)) tw *= 0.15;
    if (best === 0 && lenientPreschool && PRESCHOOL.has(t)) tw = Math.min(tw, 1);
    matched += tw * best;
    extra += tw * (1 - best);
  });
  let missing = 0;
  n.tokens.forEach((u, i) => {
    if (!used.has(i)) missing += w.weight(u);
  });
  const typo = fits.some((f) => f > 0 && f < 1);
  return { score: (matched / (matched + extra + 0.15 * missing)) * levelFit, exact: false, clash, typo };
}

/** nameFit's score alone. */
export const nameScore = (e: ParsedSchool, n: ParsedSchool, w: WordWeights, lenientPreschool = false) => nameFit(e, n, w, lenientPreschool).score;

/**
 * Initials a school's name is commonly shortened to ("Arlington Science
 * Focus School" → ASFS, "John Poole MS" → JPMS, "District of Columbia
 * International" → DCI as well as DI).
 */
export function acronymsOf(p: ParsedSchool, name = p.entered): string[] {
  const lv = { elementary: "es", middle: "ms", high: "hs", "": "" }[p.level];
  // Every word but "of", "the", "and"…: Montessori Public School of Arlington → MPSA.
  const words = name
    .toLowerCase()
    .replace(/['’`.]/g, "")
    .split(/[^a-z0-9]+/)
    .filter((w) => w && !["the", "of", "and", "at", "for", "a", "in"].includes(w));
  const named = words.map((t) => t[0]).join("");
  const core = p.tokens.map((t) => t[0]).join("");
  const out = new Set([named, core, ...(lv ? [core + lv] : []), ...(/\bschool\b/.test(name.toLowerCase()) ? [core + "s"] : [])]);
  return [...out].filter((x) => x.length >= 2);
}

/** An answer that's probably initials ("GDS", "Asfs", "jpms", "LAMB PCS", "BCC HS"); null otherwise. */
export function acronymOf(entered: string): string | null {
  // A district tag or level after the initials doesn't change them.
  const s = entered
    .replace(/(\s+(pcs|dcps|mcps|fcps|aps|es|ms|hs|elementary|middle|high|school))+\s*$/i, "")
    .replace(/[.\s-]/g, "");
  if (!/^[a-z]{2,6}$/i.test(s)) return null;
  // Capitals, or no vowel a name would have ("gds", "jpms"; not "deal", "key").
  return s === s.toUpperCase() || !/[aeiouy]/i.test(s.slice(1)) ? s.toLowerCase() : null;
}

export interface SchoolCandidate {
  id: string;
  /** Official or chosen name. */
  name: string;
  /** Spellings an admin confirmed for it: as good as its name. */
  aliases?: string[];
  /** Spellings matched to it automatically: a little weaker than its name, so they can't outvote an official name. */
  likelyAliases?: string[];
  /** Names it had before ("Wilson High School"); a little weaker, so they never tie another school's current name. */
  formerNames?: string[];
  /** Level from the official record, when the name doesn't say. */
  level?: SchoolLevel;
  /** Campers already matched to it, so an abbreviation picks the school families here actually attend. */
  campers?: number;
  /** In a county most families come from: preferred when two schools share a name. */
  nearby?: boolean;
}

export type MatchReason = "exact" | "words" | "acronym" | "ambiguous" | "multi" | "none";

export interface SchoolMatch {
  /** Best school, when there is one worth suggesting. */
  id: string | null;
  /** 0–1: ≥ 0.9 is matched automatically, 0.6–0.9 is suggested for review. */
  confidence: number;
  reason: MatchReason;
  /** Next-best schools, for the review list. */
  alternatives: Array<{ id: string; score: number }>;
}

export const AUTO_MATCH = 0.9;
/** How much a school outside the usual counties is discounted (enough to lose a tie, not to lose a clear match). */
const FAR = 0.85;
/** How much a former name is discounted against a school's current name. */
const FORMER = 0.9;
/** How much a spelling matched automatically counts against a school's own name. */
const LIKELY = 0.9;
export const SUGGEST = 0.6;

/**
 * Matches answers against a set of schools. Candidates for each answer are
 * found through an index of their words (and one-typo variants), so only a
 * handful are scored even against thousands of schools.
 */
export class SchoolMatcher {
  private readonly names: Array<{ id: string; p: ParsedSchool; factor: number }> = [];
  private readonly byWord = new Map<string, Set<number>>();
  private readonly byJoined = new Map<string, Set<number>>();
  private readonly byJoinedStart = new Map<string, Set<number>>();
  private readonly byAcronym = new Map<string, Set<string>>();
  private readonly campers = new Map<string, number>();
  /** Schools elsewhere score a little lower, so a same-named school nearby wins a tie. */
  private readonly far = new Set<string>();
  readonly weights: WordWeights;

  /**
   * `weights`: how distinctive each word is; by default, from the candidates' names.
   * `lenientPreschool`: see nameFit (for comparing answers with each other).
   */
  constructor(
    candidates: SchoolCandidate[],
    weights?: WordWeights,
    private readonly lenientPreschool = false,
  ) {
    const official: string[][] = [];
    for (const c of candidates) {
      this.campers.set(c.id, c.campers ?? 0);
      if (c.nearby === false) this.far.add(c.id);
      // "Beauvoir, the National Cathedral Elementary School" is known by both its short and its full name.
      const full = c.name.includes(",") ? [c.name.replace(/,/g, " ")] : [];
      const names: Array<[string, number]> = [
        [c.name, 1],
        ...full.map((n): [string, number] => [n, 1]),
        ...(c.aliases ?? []).map((n): [string, number] => [n, 1]),
        ...(c.likelyAliases ?? []).map((n): [string, number] => [n, LIKELY]),
        ...(c.formerNames ?? []).map((n): [string, number] => [n, FORMER]),
      ];
      names.forEach(([name, factor], k) => {
        const p = parseSchool(name);
        if (!p) return;
        if (!p.level && c.level) p.level = c.level;
        if (k === 0) official.push(p.tokens);
        const i = this.names.push({ id: c.id, p, factor }) - 1;
        for (const t of p.tokens) for (const key of wordKeys(t)) add(this.byWord, key, i);
        add(this.byJoined, p.joined, i);
        add(this.byJoinedStart, p.joined.slice(0, 3), i);
        if (k === 0) for (const a of acronymsOf(p, name)) add(this.byAcronym, a, c.id);
      });
    }
    this.weights = weights ?? new WordWeights(official);
  }

  /** Every school the answer resembles, best first, with its score (not confidence). */
  scores(entered: string): Array<{ id: string; score: number }> {
    const e = parseSchool(entered);
    return e ? this.rank(e).map(({ id, score }) => ({ id, score })) : [];
  }

  private rank(e: ParsedSchool): Ranked[] {
    // Score each school by its best-matching name.
    const scores = new Map<string, Ranked>();
    const seen = new Set<number>();
    const consider = (i: number) => {
      if (seen.has(i)) return;
      seen.add(i);
      const { id, p, factor } = this.names[i]!;
      const fit = nameFit(e, p, this.weights, this.lenientPreschool);
      const score = fit.score * (this.far.has(id) ? FAR : 1) * factor;
      const prev = scores.get(id);
      if (!prev || score > prev.score) scores.set(id, { id, score, exact: fit.exact && factor === 1, clash: fit.clash, typo: fit.typo });
    };
    for (const t of e.tokens) for (const key of wordKeys(t)) for (const i of this.byWord.get(key) ?? []) consider(i);
    for (const i of this.byJoined.get(e.joined) ?? []) consider(i);
    // Run-together answers ("Woodacres") share no word with "Wood Acres": look them up by their first letters.
    if (e.tokens.length === 1 && e.joined.length >= 7) {
      for (const i of this.byJoinedStart.get(e.joined.slice(0, 3)) ?? []) {
        if (Math.abs(this.names[i]!.p.joined.length - e.joined.length) <= 2) consider(i);
      }
    }

    return [...scores.values()].sort((a, b) => b.score - a.score || (this.campers.get(b.id) ?? 0) - (this.campers.get(a.id) ?? 0));
  }

  match(entered: string): SchoolMatch {
    const e = parseSchool(entered);
    if (!e) return { id: null, confidence: 0, reason: "none", alternatives: [] };
    const ranked = this.rank(e);
    const [best, second] = ranked;
    const alternatives = ranked.slice(1, 4).filter((r) => r.score >= 0.4).map(({ id, score }) => ({ id, score }));

    let result: SchoolMatch = { id: null, confidence: 0, reason: "none", alternatives };
    if (best && best.score >= 0.5) {
      const s = best.score;
      const s2 = second?.score ?? 0;
      // Clear of the next school, a good match is a confident one; close to it, capped below automatic.
      let confidence = s + (1 - s) * (s >= 0.75 ? 0.75 : 0.4) * (1 - s2 / s);
      let reason: MatchReason = best.exact ? "exact" : "words";
      // An exact name beats a near one ("Washington International School" over "… Academy"), unless both are exact.
      if (s2 >= SUGGEST && s - s2 < 0.08 && !(best.exact && !second!.exact)) {
        confidence = Math.min(confidence, 0.8);
        reason = "ambiguous";
      }
      // A close runner-up that far more of our campers attend ("Whitman": Walt Whitman High, not Whitman Middle).
      const c1 = this.campers.get(best.id) ?? 0;
      const c2 = second ? (this.campers.get(second.id) ?? 0) : 0;
      if (second && !best.exact && s - s2 < 0.2 && c2 >= 5 && c2 >= 5 * Math.max(1, c1)) {
        confidence = Math.min(confidence, 0.8);
        reason = "ambiguous";
      }
      // "The Flint Hill School" against Flint Hill Elementary might be a private school not in the list.
      if (best.clash) confidence = Math.min(confidence, 0.85);
      // Schools outside the usual counties are matched automatically only by their exact name.
      if (this.far.has(best.id) && !best.exact) confidence = Math.min(confidence, 0.89);
      // One short word with a typo might be a different name altogether (Bayles is not Bayne).
      if (best.typo && e.tokens.length === 1 && e.tokens[0]!.length < 7) confidence = Math.min(confidence, 0.88);
      // One word many schools share ("Park") is part of too many names to pick one.
      if (!best.exact && e.tokens.length === 1 && this.weights.count(e.tokens[0]!) >= 5) confidence = Math.min(confidence, 0.85);
      result = { id: best.id, confidence, reason, alternatives };
    }

    // Initials: the school families here actually attend, when it clearly leads. Capitals ("LAMB") are read as
    // initials before words; otherwise only when the words found nothing sure.
    const ac = acronymOf(entered);
    const capitals = ac !== null && entered.replace(/[^a-z]/gi, "") === entered.replace(/[^a-z]/gi, "").toUpperCase();
    // Capitals that aren't anyone's initials still aren't a word with a typo ("MPSA" is not Mysa).
    if (capitals && !best?.exact) result = { ...result, confidence: Math.min(result.confidence, 0.8) };
    if (ac && (result.confidence < AUTO_MATCH || (capitals && !best?.exact))) {
      const hits = [...(this.byAcronym.get(ac) ?? [])].sort((a, b) => (this.campers.get(b) ?? 0) - (this.campers.get(a) ?? 0));
      if (hits.length) {
        const top = this.campers.get(hits[0]!) ?? 0;
        const next = hits[1] ? (this.campers.get(hits[1]) ?? 0) : 0;
        // Two letters are too few to be sure of.
        const clear = ac.length >= 3 && top >= 10 && top >= 5 * next;
        result = {
          id: hits[0]!,
          confidence: clear ? 0.9 : hits.length === 1 && !this.far.has(hits[0]!) ? 0.8 : 0.65,
          reason: clear || hits.length === 1 ? "acronym" : "ambiguous",
          alternatives: hits.slice(1, 4).map((id) => ({ id, score: 0.5 })),
        };
      } else if (capitals && !best?.exact) {
        // Initials of no school we know ("NCRC"): don't suggest a look-alike word.
        result = { id: null, confidence: 0, reason: "none", alternatives: [] };
      }
    }
    if (e.multi) result = { ...result, confidence: Math.min(result.confidence, 0.8), reason: "multi" };
    return result;
  }
}

/** One school's best fit to an answer. */
interface Ranked {
  id: string;
  score: number;
  exact: boolean;
  clash: boolean;
  typo: boolean;
}

function add<K, V>(m: Map<K, Set<V>>, k: K, v: V) {
  let s = m.get(k);
  if (!s) m.set(k, (s = new Set()));
  s.add(v);
}

/** Index keys for a word: itself and its one-letter deletions, so one typo still finds it (SymSpell). */
function wordKeys(t: string): string[] {
  if (t.length < 4) return [t];
  const keys = new Set([t]);
  for (let i = 0; i < t.length; i++) keys.add(t.slice(0, i) + t.slice(i + 1));
  // Abbreviations ("indep", "elem") find the full word by its start.
  keys.add(`^${t.slice(0, 4)}`);
  return [...keys];
}
