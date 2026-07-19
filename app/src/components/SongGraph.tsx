import { memo } from "react";
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ReferenceArea,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { GraphPoint, SongGraphResponse } from "../types";

/** Amber bands match song energy — not the pink enjoyment line. */
const BAND_FILL = "#E8A84A";

/** The per-song "graph of emotion overlaid on the music" (RFC §6 song-graph),
 * now rendered in real-time inside the feed. */
function SongGraph({
  song,
  points,
}: {
  song: SongGraphResponse["song"];
  points: GraphPoint[];
}) {
  const highSections = song.sections?.filter((s) => s.label === "high") ?? [];

  return (
    <div className="song-graph">
      <ResponsiveContainer width="100%" height={360}>
        <LineChart data={points} margin={{ top: 8, right: 16, bottom: 8, left: 0 }}>
          <CartesianGrid stroke="rgba(143, 143, 157, 0.28)" strokeDasharray="3 3" />
          <XAxis
            type="number"
            dataKey="t"
            domain={[0, song.duration_s ?? "auto"]}
            stroke="var(--muted)"
            label={{ value: "seconds elapsed", position: "insideBottomRight", offset: -10 }}
          />
          <YAxis domain={[0, 1]} stroke="var(--muted)" />
          {highSections.map((s) => (
            <ReferenceArea
              key={`${s.start_s}-${s.end_s}`}
              x1={s.start_s}
              x2={s.end_s}
              fill={BAND_FILL}
              fillOpacity={0.14}
            />
          ))}
          <Tooltip
            contentStyle={{ background: "var(--panel)", border: "1px solid var(--border)", color: "var(--text)" }}
            labelFormatter={(t) => `t = ${t}s`}
            formatter={(value: number | string, name: string) =>
              typeof value === "number" ? [Math.round(value * 100), name] : [value, name]
            }
          />
          <Legend />
          <Line type="monotone" dataKey="enjoyment" stroke="#FF5D8F" dot={false} strokeWidth={2.5} connectNulls name="enjoyment (you)" />
          <Line type="monotone" dataKey="energy" stroke="#E8A84A" dot={false} strokeDasharray="4 3" connectNulls name="song energy" />
          <Line type="monotone" dataKey="onset_density" stroke="#C97B9A" dot={false} strokeDasharray="2 4" connectNulls name="onset density" />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

export default memo(SongGraph);
