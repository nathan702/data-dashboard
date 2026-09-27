import { useEffect, useRef } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import type { EnrollmentMapPoint } from "@dash/shared";
import { formatInt } from "../lib/format";

/** Central DC area, used until there are points to frame. */
const DC: L.LatLngTuple = [38.93, -77.1];

/** Frame the middle 96% of homes so a few far-away families don't zoom the map out to the whole East Coast. */
function coreBounds(points: EnrollmentMapPoint[]): L.LatLngBounds | null {
  if (points.length === 0) return null;
  const q = (xs: number[], p: number) => xs[Math.min(xs.length - 1, Math.max(0, Math.round(p * (xs.length - 1))))]!;
  const lats = points.map((p) => p.lat).sort((a, b) => a - b);
  const lons = points.map((p) => p.lon).sort((a, b) => a - b);
  const [lo, hi] = points.length > 20 ? [0.02, 0.98] : [0, 1];
  return L.latLngBounds([q(lats, lo), q(lons, lo)], [q(lats, hi), q(lons, hi)]);
}

const radius = (campers: number) => Math.min(8, 3.5 + campers);

/**
 * One dot per home. `fitKey` changes when the filters do, which re-frames the
 * map; refreshed data for the same filters keeps the current view.
 */
export default function FamilyMap({ points, fitKey }: { points: EnrollmentMapPoint[]; fitKey: string }) {
  const el = useRef<HTMLDivElement>(null);
  const map = useRef<L.Map | null>(null);
  const layer = useRef<L.LayerGroup | null>(null);
  const fitted = useRef<string | null>(null);

  useEffect(() => {
    if (!el.current || map.current) return;
    // SVG rather than canvas: a few thousand dots is fine, and canvas redraws can fire after the map is removed.
    const m = L.map(el.current, { scrollWheelZoom: false, center: DC, zoom: 10 });
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 18,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
      className: "map-tiles",
    }).addTo(m);
    // Scroll-zoom only after a click, so the page still scrolls past the map.
    m.on("click", () => m.scrollWheelZoom.enable());
    m.on("mouseout", () => m.scrollWheelZoom.disable());
    layer.current = L.layerGroup().addTo(m);
    map.current = m;
    return () => {
      m.remove();
      map.current = null;
      layer.current = null;
      fitted.current = null;
    };
  }, []);

  useEffect(() => {
    const m = map.current;
    const g = layer.current;
    if (!m || !g) return;
    g.clearLayers();
    const accent = getComputedStyle(document.documentElement).getPropertyValue("--accent").trim() || "#2a78d6";
    for (const p of points) {
      L.circleMarker([p.lat, p.lon], { radius: radius(p.campers), color: "#ffffff", weight: 1, fillColor: accent, fillOpacity: 0.75 })
        .bindTooltip(`${formatInt(p.campers)} camper${p.campers === 1 ? "" : "s"} · ${formatInt(p.enrollments)} enrollment${p.enrollments === 1 ? "" : "s"}`)
        .addTo(g);
    }
    if (fitted.current !== fitKey) {
      const b = coreBounds(points);
      if (b) {
        // No animation: a zoom still running when the map is torn down breaks Leaflet's canvas.
        m.fitBounds(b, { padding: [24, 24], maxZoom: 13, animate: false });
        fitted.current = fitKey;
      }
    }
  }, [points, fitKey]);

  return <div ref={el} className="family-map" role="region" aria-label="Map of where families live" />;
}
