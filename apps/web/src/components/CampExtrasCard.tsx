import type { BusinessLineOrUnassigned, CampminderExtras } from "@dash/shared";
import { useCampminderExtras } from "../lib/api";
import { formatDate, formatInt, formatPercent, formatUsd, percentChange } from "../lib/format";

const th = { padding: "8px 16px" };

/**
 * Camp extras from Campminder's Financial report: line items that aren't
 * tuition (Week N Lunch, Gear Bag, Backpack…), against last season at the
 * same point; lunches by week and session group, and summer-long items by
 * each camper's first session.
 */
export function CampExtrasCard({ season, businessLine }: { season: number | undefined; businessLine?: BusinessLineOrUnassigned }) {
  const { data, error } = useCampminderExtras({ season, businessLine });
  if (error) return <div className="error-banner">Couldn't load camp extras: {error.message}</div>;
  if (!data || data.items.length === 0) return null;
  const weekly = data.bySession.filter((r) => r.week !== null);
  const summerLong = data.bySession.filter((r) => r.week === null);
  return (
    <div className="card">
      <h3 className="card-title">Camp extras</h3>
      <p className="card-subtitle">
        Line items that aren't tuition (Miscellaneous charges such as lunches, gear bags and backpacks), season {data.season}, net of credits and
        reversals. Last season counts what was posted by {formatDate(data.lastSeasonCutoff)}. The page's filters don't apply here.
      </p>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th style={th}>Item</th>
              <th className="num" style={th}>Sold</th>
              <th className="num" style={th}>Revenue</th>
              <th className="num" style={th}>Sold last season</th>
              <th className="num" style={th}>Revenue last season</th>
              <th className="num" style={th}>Change</th>
            </tr>
          </thead>
          <tbody>
            {data.items.map((i) => (
              <tr key={i.item}>
                <td>{i.item}</td>
                <td className="num">{formatInt(i.count)}</td>
                <td className="num">{formatUsd(i.revenue)}</td>
                <td className="num muted">{formatInt(i.lastCount)}</td>
                <td className="num muted">{formatUsd(i.lastRevenue)}</td>
                <td className="num">{formatPercent(percentChange(i.revenue, i.lastRevenue))}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {weekly.length > 0 && <Grid title="By week and session group" note="Each week's items under the session on the same line." rows={weekly} columns="week" />}
      {summerLong.length > 0 && (
        <Grid title="Summer-long items by first session" note="Items without a session of their own go with the camper's first enrolled session that season." rows={summerLong} columns="item" />
      )}
    </div>
  );
}

/** Items sold: session groups down, weeks (one table per weekly item) or items across. */
function Grid({ title, note, rows, columns }: { title: string; note: string; rows: CampminderExtras["bySession"]; columns: "week" | "item" }) {
  const tables = columns === "week" ? [...new Set(rows.map((r) => r.item))] : [null];
  return (
    <>
      {tables.map((item) => {
        const rs = item === null ? rows : rows.filter((r) => r.item === item);
        const colOf = (r: (typeof rows)[number]) => (columns === "week" ? `Week ${r.week}` : r.item);
        const cols = [...new Set(rs.map(colOf))].sort((a, b) => (columns === "week" ? Number(a.slice(5)) - Number(b.slice(5)) : a.localeCompare(b)));
        const groups = [...new Set(rs.map((r) => r.sessionGroup ?? "No session"))].sort();
        const cell = new Map<string, number>();
        for (const r of rs) {
          const k = `${r.sessionGroup ?? "No session"}|${colOf(r)}`;
          cell.set(k, (cell.get(k) ?? 0) + r.count);
        }
        const colTotal = (c: string) => groups.reduce((t, g) => t + (cell.get(`${g}|${c}`) ?? 0), 0);
        const rowTotal = (g: string) => cols.reduce((t, c) => t + (cell.get(`${g}|${c}`) ?? 0), 0);
        return (
          <div key={item ?? "all"} style={{ marginTop: 16 }}>
            <h4 className="table-title">{item ? `${item}: ${title.toLowerCase()}` : title}</h4>
            <p className="card-subtitle">{note}</p>
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th style={th}>Session group</th>
                    {cols.map((c) => (
                      <th key={c} className="num" style={th}>
                        {c}
                      </th>
                    ))}
                    <th className="num" style={th}>
                      Total
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {groups.map((g) => (
                    <tr key={g}>
                      <td>{g}</td>
                      {cols.map((c) => (
                        <td key={c} className="num">
                          {cell.has(`${g}|${c}`) ? formatInt(cell.get(`${g}|${c}`)!) : <span className="muted">–</span>}
                        </td>
                      ))}
                      <td className="num">{formatInt(rowTotal(g))}</td>
                    </tr>
                  ))}
                  <tr>
                    <td>
                      <strong>Total</strong>
                    </td>
                    {cols.map((c) => (
                      <td key={c} className="num">
                        <strong>{formatInt(colTotal(c))}</strong>
                      </td>
                    ))}
                    <td className="num">
                      <strong>{formatInt(cols.reduce((t, c) => t + colTotal(c), 0))}</strong>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        );
      })}
    </>
  );
}
