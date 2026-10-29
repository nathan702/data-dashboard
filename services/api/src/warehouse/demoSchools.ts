import type { OfficialSchool } from "@dash/shared";

/** Made-up "official directory" for the demo: most demo schools are in it, a few aren't (so the review list has items). */
export const DEMO_OFFICIAL_SCHOOLS: OfficialSchool[] = [
  { id: "nces-demo-1", name: "Maple Grove Elementary School", level: "elementary", type: "public", state: "MD", county: "Montgomery County", city: "Bethesda" },
  { id: "nces-demo-2", name: "The Hilltop School", level: "", type: "private", state: "DC", county: "District of Columbia", city: "Washington" },
  { id: "nces-demo-3", name: "Riverbend Day School", level: "", type: "private", state: "VA", county: "Fairfax County", city: "McLean" },
  { id: "nces-demo-4", name: "Oak Hill Middle School", level: "middle", type: "public", state: "VA", county: "Arlington County", city: "Arlington" },
  { id: "nces-demo-5", name: "Cedar Park Elementary School", level: "elementary", type: "public", state: "MD", county: "Montgomery County", city: "Potomac" },
  { id: "nces-demo-6", name: "Oak Hill Elementary School", level: "elementary", type: "public", state: "VA", county: "Arlington County", city: "Arlington" },
];
