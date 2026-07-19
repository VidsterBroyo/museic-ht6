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

/** The per-song "graph of emotion overlaid on the music" (RFC §6 song-graph),
 * now rendered in real-time inside the feed. */
function SongGraph({
  song,
  points,
}: {
  song: SongGraphResponse["song"];
  points: GraphPoint[];
}) {
  return (
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
        <YAxis domain={[-1, 1]} stroke="var(--muted)" />
        {song.sections?.map((s) =>
          s.label === "high" ? (
            <ReferenceArea
              key={`${s.start_s}-${s.end_s}`}
              x1={s.start_s}
              x2={s.end_s}
              fill="#FF5D8F"
              fillOpacity={0.1}
            />
          ) : null,
        )}
        <Tooltip
          contentStyle={{ background: "var(--panel)", border: "1px solid var(--border)", color: "var(--text)" }}
          labelFormatter={(t) => `t = ${t}s`}
        />
        <Legend />
        <Line type="monotone" dataKey="arousal" stroke="#FF5D8F" dot={false} strokeWidth={2} connectNulls name="arousal (you)" />
        <Line type="monotone" dataKey="valence" stroke="#7A9BB8" dot={false} strokeWidth={2} connectNulls name="valence (you)" />
        <Line type="monotone" dataKey="energy" stroke="#E8A84A" dot={false} strokeDasharray="4 3" connectNulls name="song energy" />
        <Line type="monotone" dataKey="onset_density" stroke="#C97B9A" dot={false} strokeDasharray="2 4" connectNulls name="onset density" />
      </LineChart>
    </ResponsiveContainer>
  );
}

export default memo(SongGraph);
