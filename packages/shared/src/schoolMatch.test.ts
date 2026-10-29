import { describe, expect, it } from "vitest";
import { AUTO_MATCH, SchoolMatcher, acronymOf, parseSchool, type SchoolCandidate } from "./schoolMatch.js";

// Official-style names for the test (as an official directory would list them).
const SCHOOLS: SchoolCandidate[] = [
  { id: "amh", name: "Arlington Montessori House" },
  { id: "asfs", name: "Arlington Science Focus Elementary School", campers: 40 },
  { id: "ats", name: "Arlington Traditional School" },
  { id: "bannockburn", name: "Bannockburn Elementary School", campers: 120 },
  { id: "bancroft", name: "Bancroft Elementary School", campers: 170 },
  { id: "barcroft", name: "Barcroft Elementary School" },
  { id: "barnesville", name: "Barnesville School of Arts and Sciences" },
  { id: "beauvoir", name: "Beauvoir, the National Cathedral Elementary School", aliases: ["Beauvoir School"] },
  { id: "banneker", name: "Benjamin Banneker Academic High School" },
  { id: "bradley", name: "Bradley Hills Elementary School" },
  { id: "pyle", name: "Thomas W. Pyle Middle School" },
  { id: "deal", name: "Alice Deal Middle School" },
  { id: "sidwell", name: "Sidwell Friends School" },
  { id: "gds", name: "Georgetown Day School", campers: 70 },
  { id: "potomac-es", name: "Potomac Elementary School" },
  { id: "potomac-school", name: "The Potomac School" },
  { id: "key-dc", name: "Key Elementary School" },
  { id: "escuela-key", name: "Escuela Key Elementary School" },
  { id: "wood-acres", name: "Wood Acres Elementary School", campers: 150 },
  { id: "westbrook", name: "Westbrook Elementary School", campers: 55 },
  { id: "wyngate", name: "Wyngate Elementary School", campers: 70 },
  { id: "discovery", name: "Discovery Elementary School" },
  { id: "bethesda-es", name: "Bethesda Elementary School" },
  { id: "bcc", name: "Bethesda-Chevy Chase High School" },
  { id: "jackson-reed", name: "Jackson-Reed High School", aliases: ["Wilson High School"] },
  { id: "carderock", name: "Carderock Springs Elementary School" },
];
const m = new SchoolMatcher(SCHOOLS);
const auto = (entered: string) => {
  const r = m.match(entered);
  return r.confidence >= AUTO_MATCH ? r.id : null;
};

describe("school matching", () => {
  it("matches the spellings families actually type", () => {
    const cases: Array<[string, string]> = [
      ["Arlington Montessori", "amh"],
      ["Arlington Science Focus", "asfs"],
      ["Arlington science focus center", "asfs"],
      ["Bannockbrun ES", "bannockburn"],
      ["Barnesville", "barnesville"],
      ["Barnesville Academy of Arts and Sciences", "barnesville"],
      ["Barnesville School of Arts & Sciences", "barnesville"],
      ["Beauvier", "beauvoir"],
      ["Beauviour", "beauvoir"],
      ["Benjamin Banneker", "banneker"],
      ["Bradley Hlls ES", "bradley"],
      ["Pyle", "pyle"],
      ["Thomas Pyle MS", "pyle"],
      ["Deal", "deal"],
      ["Sidwell", "sidwell"],
      ["Woodacres", "wood-acres"],
      ["wOOD aCRES", "wood-acres"],
      ["Murch (DCPS)".replace("Murch", "Bancroft"), "bancroft"],
      ["Bancroft Elementary, DC", "bancroft"],
      ["Discovery Elementary School Arlington VA", "discovery"],
      ["Carderock Srpings", "carderock"],
      ["Wilson HS", "jackson-reed"],
      ["Jackson Reed", "jackson-reed"],
      // Escuela Key families write "Escuela Key"; a bare "Key" is the Key Elementary.
      ["Key", "key-dc"],
    ];
    for (const [entered, id] of cases) expect([entered, auto(entered)]).toEqual([entered, id]);
  });

  it("prefers the exact school over a near-miss of another", () => {
    expect(auto("Barcroft ES")).toBe("barcroft");
    expect(auto("Bancroft")).toBe("bancroft");
    expect(auto("The Potomac School")).toBe("potomac-school");
    expect(auto("Potomac Elementary")).toBe("potomac-es");
  });

  it("sends real ambiguity to review instead of guessing", () => {
    for (const entered of ["Potomac", "Pyle/Whitman"]) {
      const r = m.match(entered);
      expect([entered, r.confidence < AUTO_MATCH]).toEqual([entered, true]);
      expect(r.id).not.toBeNull();
    }
    // A different school that merely shares a place name isn't a match.
    expect(auto("Bethesda Montessori School")).toBeNull();
    expect(auto("Arlington Glebe Elementary")).toBeNull();
  });

  it("reads initials, picking the school families here attend only when it clearly leads", () => {
    expect(acronymOf("GDS")).toBe("gds");
    expect(acronymOf("Asfs")).toBe("asfs");
    expect(acronymOf("Deal")).toBeNull();
    expect(auto("GDS")).toBe("gds");
    expect(auto("ASFS")).toBe("asfs");
    // Both Wyngate and Westbrook Elementary shorten to WES, and neither clearly leads.
    const wes = m.match("WES");
    expect(wes.confidence).toBeLessThan(AUTO_MATCH);
    expect([wes.id, ...wes.alternatives.map((a) => a.id)]).toEqual(["wyngate", "westbrook"]);
  });

  it("reduces a name to what identifies it", () => {
    expect(parseSchool("Thomas Pyle MIddle school")).toMatchObject({ tokens: ["thoma", "pyle"].map((t) => t), level: "middle" });
    expect(parseSchool("Kent Garden E")).toMatchObject({ tokens: ["kent", "garden"], level: "elementary" });
    expect(parseSchool("High Point Elementary")).toMatchObject({ tokens: ["high", "point"], level: "elementary" });
    expect(parseSchool("Taylor Elementary now/Dorothy Hamm for 6th grade")).toMatchObject({ tokens: ["taylor"], multi: true });
  });

  it("doesn't guess on the traps found in real answers", () => {
    const t = new SchoolMatcher([
      { id: "lamb", name: "Latin American Montessori Bilingual PCS" },
      { id: "lamb-of-god", name: "The Lamb of God School" },
      { id: "bayne", name: "John H. Bayne Elementary" },
      { id: "mysa", name: "Mysa School" },
      { id: "mpsa", name: "Montessori Public School of Arlington" },
      { id: "whitman-ms", name: "Whitman Middle" },
      { id: "walt-whitman", name: "Walt Whitman High", campers: 30 },
      { id: "deal", name: "Deal MS" },
      { id: "deal-island", name: "Deal Island School", nearby: false },
      { id: "innovation", name: "Innovation Elementary", formerNames: ["Arlington Science Focus Elementary"] },
      { id: "asfs", name: "Arlington Science Focus School", level: "elementary" },
    ]);
    const sure = (e: string) => {
      const r = t.match(e);
      return r.confidence >= AUTO_MATCH ? r.id : null;
    };
    // Capitals are read as initials first, and never as a misspelled word.
    expect(t.match("LAMB").id).toBe("lamb");
    expect(t.match("LAMB PCS").id).toBe("lamb");
    expect(t.match("MPSA").id).toBe("mpsa");
    // One short word with a typo might be another name.
    expect(sure("Bayles")).toBeNull();
    // A close runner-up that far more campers attend sends it to review.
    expect(sure("Whitman")).toBeNull();
    // A same-named school far away doesn't compete; a former name doesn't tie a current one.
    expect(sure("Deal")).toBe("deal");
    // A first name the official list leaves off still points to the school (automatic on the real list's word weights).
    expect(t.match("Alice Deal Middle School").id).toBe("deal");
    expect(sure("Arlington Science Focus School")).toBe("asfs");
    // A country isn't a school.
    expect(t.match("Germany").id).toBeNull();
  });
});
