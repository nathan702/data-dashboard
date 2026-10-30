/**
 * Parent occupations, as categories only. Campminder has each parent's
 * occupation as typed ("Attorney", "partner at a law firm", "SAHM"); the
 * import sorts it into one of these categories and keeps nothing else, since
 * a job title can identify a family ("U.S. Senator", "CEO of …").
 */

export const OCCUPATION_CATEGORIES = [
  "Legal",
  "Medicine and health",
  "Education",
  "Government and military",
  "Finance",
  "Technology",
  "Business and management",
  "Nonprofit",
  "Science and research",
  "Arts and media",
  "Real estate and construction",
  "Trades",
  "Homemaker",
  "Retired",
  "Other",
] as const;
export type OccupationCategory = (typeof OCCUPATION_CATEGORIES)[number];

/**
 * Words and phrases for each category, checked in this order: the first
 * category with a match wins, so specific fields come before broad ones
 * ("real estate attorney" is Legal; "nonprofit director" is Nonprofit before
 * "director" makes it Business). Each entry matches whole words; a trailing
 * "*" also matches longer words ("pediatric*" → pediatrician, pediatrics).
 */
const RULES: Array<[OccupationCategory, string[]]> = [
  // Phrases that would otherwise land in the wrong field ("law enforcement" isn't Legal, a data scientist isn't a lab scientist).
  ["Government and military", ["law enforcement", "police officer", "military officer", "foreign service officer", "federal agent"]],
  ["Technology", ["data scientist*", "data science", "data engineer*", "computer scientist*"]],
  ["Retired", ["retired", "retiree"]],
  [
    "Homemaker",
    [
      "homemaker", "home maker", "housewife", "house wife", "househusband", "stay at home", "sahm", "sahd", "sahp", "full time parent",
      "full time mom", "full time dad", "full time mother", "full time father", "caregiver", "domestic engineer",
    ],
  ],
  [
    "Legal",
    [
      "attorney*", "lawyer*", "counsel", "general counsel", "paralegal*", "judge", "judicial", "law", "law firm", "legal", "litigat*",
      "esq", "esquire", "solicitor", "prosecutor", "public defender", "magistrate", "clerk of court",
    ],
  ],
  [
    "Medicine and health",
    [
      "physician*", "doctor", "md", "m d", "surgeon*", "nurse*", "nursing", "rn", "np", "crnp", "dentist*", "dental", "orthodont*",
      "pharmac*", "therapist*", "therapy", "physical therapist", "occupational therapist", "speech pathologist", "psycholog*",
      "psychiatr*", "veterinar*", "vet", "dvm", "medical", "medicine", "health*", "hospital*", "clinic*", "clinical", "pediatric*",
      "radiolog*", "anesthes*", "cardiolog*", "oncolog*", "dermatolog*", "neurolog*", "chiropract*", "optometr*", "ophthalm*",
      "physician assistant", "pa-c", "dietitian", "nutritionist", "midwife", "doula", "emt", "paramedic", "counselor", "lcsw",
      "obgyn", "ob/gyn", "gastroenterolog*", "endocrinolog*", "urolog*", "orthopedic*", "audiolog*", "hospitalist", "internist",
    ],
  ],
  [
    "Real estate and construction",
    [
      "real estate", "realtor*", "realty", "architect*", "construction", "contractor", "general contractor", "builder*", "homebuilder",
      "civil engineer*", "structural engineer*", "property manager", "property management", "developer real estate", "land use",
      "interior design*", "urban planner", "planner urban", "surveyor",
    ],
  ],
  [
    "Science and research",
    [
      "scientist*", "research*", "chemist*", "biologist*", "physicist*", "nih", "laboratory", "lab", "postdoc*", "post-doc*",
      "epidemiolog*", "statistician*", "geologist*", "astronom*", "ecologist*", "biotech*", "pharmaceutical*", "neuroscien*",
      "geneticist*", "immunolog*", "microbiolog*", "mathematician*", "economist*",
    ],
  ],
  [
    "Education",
    [
      "teacher*", "teaching", "professor*", "prof", "educator*", "education*", "principal", "school", "tutor*", "faculty",
      "lecturer*", "academic*", "dean", "librarian*", "instructor*", "university", "college", "head of school", "superintendent",
      "special ed*", "preschool", "daycare", "child care", "childcare", "student*", "graduate student", "phd student",
    ],
  ],
  [
    "Government and military",
    [
      "government*", "govt", "gov", "federal*", "fed", "state department", "department of state", "foreign service", "diplomat*",
      "congress*", "senate", "senator", "congressional", "capitol hill", "hill staff*", "white house", "policy", "public policy",
      "military", "army", "navy", "naval", "air force", "usaf", "marine*", "usmc", "coast guard", "police", "law enforcement",
      "fbi", "cia", "nsa", "dod", "defense", "pentagon", "civil servant", "civil service", "public servant", "public service",
      "intelligence", "usaid", "world bank", "imf", "embassy", "ambassador", "county", "city of", "public sector",
      "firefighter*", "fire fighter*", "lobbyist*", "lobbying",
    ],
  ],
  [
    "Finance",
    [
      "finance", "financial", "banker*", "banking", "bank", "investment*", "investor*", "investing", "portfolio", "private equity",
      "venture", "venture capital", "hedge fund", "accountant*", "cpa", "accounting", "auditor*", "audit", "actuar*", "insurance",
      "wealth", "wealth management", "asset management", "trader*", "trading", "cfo", "controller", "treasurer", "fund", "mortgage",
      "underwriter*", "credit", "tax", "financial advisor", "financial planner",
    ],
  ],
  [
    "Technology",
    [
      "software", "engineer*", "engineering", "developer*", "programmer*", "programming", "it", "information technology", "data",
      "data scientist", "tech", "technology", "cyber*", "cybersecurity", "computer*", "web", "ux", "ui", "cto", "cio", "devops",
      "product manager", "product management", "systems", "network", "cloud", "ai", "machine learning", "telecom*",
    ],
  ],
  [
    "Nonprofit",
    [
      "nonprofit", "non-profit", "non profit", "ngo", "foundation", "philanthrop*", "fundraising", "fundraiser", "advocacy",
      "advocate", "social worker", "social work", "ministry", "pastor", "clergy", "rabbi", "priest", "minister", "reverend", "chaplain",
      "charity", "think tank", "humanitarian", "community organizer",
    ],
  ],
  [
    "Arts and media",
    [
      "artist*", "art", "arts", "writer*", "author*", "journalist*", "journalism", "editor*", "reporter*", "producer*", "musician*",
      "music", "photograph*", "film*", "filmmaker*", "actor*", "actress*", "designer*", "graphic design*", "media", "communications",
      "public relations", "pr", "publisher*", "publishing", "creative", "art director", "broadcast*", "television", "tv", "radio",
      "news", "dancer*", "choreograph*", "composer*", "animator*", "copywriter*", "content",
    ],
  ],
  [
    "Trades",
    [
      "electrician*", "plumber*", "carpenter*", "mechanic*", "hvac", "landscap*", "technician*", "welder*", "chef*", "cook*",
      "driver*", "pilot*", "farmer*", "farm*", "machinist*", "painter*", "mason*", "roofer*", "craftsman", "tradesman", "trades",
      "barber*", "hairdresser*", "stylist*", "baker*", "butcher*", "installer*", "repair*", "maintenance", "custodian*", "janitor*",
      "groundskeeper*", "horticultur*", "gardener*", "equestrian", "trainer*",
    ],
  ],
  [
    "Business and management",
    [
      "ceo", "coo", "cmo", "executive*", "exec", "president", "vice president", "vp", "svp", "evp", "director*", "manager*",
      "management", "consultant*", "consulting", "business*", "owner*", "small business", "self employed", "self-employed",
      "entrepreneur*", "founder*", "co-founder*", "cofounder*", "sales*", "marketing", "operations", "ops", "hr", "human resources",
      "recruiter*", "recruiting", "administrator*", "administrative", "admin", "partner", "principal", "analyst*", "associate",
      "retail", "real estate investor", "strategy", "strategist*", "project manager", "program manager", "program", "office",
      "assistant", "coordinator*", "specialist*", "officer", "chief", "head", "lead", "supervisor*", "employee", "staff", "account",
      "accounts", "logistics", "supply chain", "procurement", "contracting", "contracts", "government contractor", "event*",
      "hospitality", "restaurant*", "hotel*", "travel",
    ],
  ],
];

/** Answers that say nothing about the job. */
const NOT_GIVEN = /^(n\/?a|na|none|no|nope|unknown|not applicable|not employed|unemployed|-+|\.+|x|tbd|other|private|prefer not to say)$/i;

/** Rules compiled to regular expressions, once: whole words, "*" for longer forms, a space also matching "-". */
const COMPILED: Array<[OccupationCategory, RegExp]> = RULES.map(([category, words]) => {
  const alternatives = words.map((w) => {
    const stem = w.toLowerCase().replace(/\*$/, "");
    const body = stem.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/ /g, "[\\s-]+");
    return w.endsWith("*") ? `${body}[a-z]*` : body;
  });
  return [category, new RegExp(`(?:^|[^a-z0-9])(?:${alternatives.join("|")})(?=$|[^a-z0-9])`)];
});

/** A whole answer that just names a parent ("Mom", "Dad"): at home with the children. */
const JUST_PARENT = /^(mom|mommy|mother|dad|daddy|father|parent|home|at home)$/;

/**
 * The category of one parent's occupation as typed; null when nothing was
 * given ("", "N/A", "none") or the answer isn't an occupation at all (an
 * email address or phone number typed into the box). Anything else that
 * doesn't fit a category is "Other".
 */
export function classifyOccupation(raw: string | null | undefined): OccupationCategory | null {
  const s = (raw ?? "").replace(/\s+/g, " ").trim();
  if (!s || s === "Undefined" || NOT_GIVEN.test(s.replace(/[.!]+$/, ""))) return null;
  if (s.includes("@") || /\d{3}\D{0,2}\d{3}\D{0,2}\d{4}/.test(s) || !/[a-z]{2}/i.test(s)) return null;
  const text = s.toLowerCase().replace(/[’']/g, "");
  if (JUST_PARENT.test(text)) return "Homemaker";
  for (const [category, re] of COMPILED) if (re.test(text)) return category;
  return "Other";
}

/** A family's categories from up to four parents' answers: each category once, in the list's order. */
export function occupationCategories(answers: Array<string | null | undefined>): OccupationCategory[] {
  const found = new Set(answers.map(classifyOccupation).filter((c): c is OccupationCategory => c !== null));
  return OCCUPATION_CATEGORIES.filter((c) => found.has(c));
}
