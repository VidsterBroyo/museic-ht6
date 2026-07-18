import { useEffect, useState } from "react";
import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceArea,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { api } from "../api";
import type { GraphPoint, SongGraphResponse } from "../types";

/**
 * Per-song "graph of emotion overlaid on the music" (RFC §6).
 *
 * Two visual groups, distinguished by role (not just hue):
 *  - YOUR BODY: arousal / Muse EEG / valence — solid, saturated series lines.
 *  - THE MUSIC: song energy / onset density — recessive dashed grey context.
 * Series colours are the validated categorical palette (CVD-checked against the
 * dark surface); they live as CSS custom properties on .song-graph so light/dark
 * and theming swap in one place.
 */

type SeriesKey = keyof Pick<
  GraphPoint,
  "arousal" | "muse" | "valence" | "energy" | "onset_density"
>;

interface SeriesDef {
  key: SeriesKey;
  label: string;
  color: string;
  group: "body" | "music";
  format: (v: number) => string;
  width: number;
  dash?: string;
}

const pct = (v: number) => `${Math.round(v * 100)}%`;
const signed = (v: number) => (v >= 0 ? `+${v.toFixed(2)}` : v.toFixed(2));
const num = (v: number) => v.toFixed(2);

const SERIES: SeriesDef[] = [
  { key: "arousal", label: "Arousal", color: "var(--series-arousal)", group: "body", format: pct, width: 2.5 },
  { key: "muse", label: "Muse · EEG", color: "var(--series-muse)", group: "body", format: pct, width: 2 },
  { key: "valence", label: "Valence", color: "var(--series-valence)", group: "body", format: signed, width: 2 },
  { key: "energy", label: "Song energy", color: "var(--music-energy)", group: "music", format: pct, width: 1.5, dash: "5 4" },
  { key: "onset_density", label: "Onset density", color: "var(--music-onset)", group: "music", format: num, width: 1.5, dash: "2 4" },
];

export default function SongGraph({
  songId,
  userId,
  onBack,
}: {
  songId: string;
  userId: string;
  onBack: () => void;
}) {
  const [data, setData] = useState<SongGraphResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setData(null);
    setError(null);
    api<SongGraphResponse>(
      `/song-graph/${encodeURIComponent(userId)}/${encodeURIComponent(songId)}`,
    )
      .then(setData)
      .catch((e) => setError(String(e)));
  }, [songId, userId]);

  if (error)
    return (
      <div className="pad">
        <button onClick={onBack}>← back</button>
        <p className="error">{error}</p>
        <p className="muted">React to this song first, then the graph will exist.</p>
      </div>
    );
  if (!data) return <div className="pad muted">loading graph…</div>;

  const { song, points } = data;
  // Only draw a series that actually has data (e.g. hide the Muse line entirely
  // when no headband was connected, rather than showing a dead legend entry).
  const active = SERIES.filter((s) => points.some((p) => p[s.key] != null));
  const body = active.filter((s) => s.group === "body");
  const music = active.filter((s) => s.group === "music");

  return (
    <div className="pad song-graph">
      <button className="ghost" onClick={onBack}>
        ← back to feed
      </button>

      <header className="graph-head">
        <h2>{song.title}</h2>
        <p className="muted">{song.artist || "unknown artist"}</p>
        <p className="muted small graph-meta">
          {[song.tempo_bpm && `${song.tempo_bpm} bpm`, song.key, "your reaction, second by second"]
            .filter(Boolean)
            .join(" · ")}
        </p>
      </header>

      <div className="chart-box">
        <ResponsiveContainer width="100%" height={380}>
          <LineChart data={points} margin={{ top: 10, right: 18, bottom: 4, left: -8 }}>
            <CartesianGrid stroke="var(--grid)" strokeDasharray="0" vertical={false} />
            {/* high-energy song sections, shaded behind everything */}
            {song.sections
              .filter((s) => s.label === "high")
              .map((s) => (
                <ReferenceArea
                  key={`${s.start_s}-${s.end_s}`}
                  x1={s.start_s}
                  x2={s.end_s}
                  fill="var(--section-fill)"
                  fillOpacity={1}
                  stroke="none"
                />
              ))}
            <ReferenceLine y={0} stroke="var(--zero-line)" strokeWidth={1} />
            <XAxis
              dataKey="t"
              stroke="var(--axis)"
              tick={{ fill: "var(--axis-text)", fontSize: 11 }}
              tickLine={false}
              tickFormatter={(t) => `${t}s`}
              minTickGap={28}
            />
            <YAxis
              domain={[-1, 1]}
              ticks={[-1, -0.5, 0, 0.5, 1]}
              stroke="var(--axis)"
              tick={{ fill: "var(--axis-text)", fontSize: 11 }}
              tickLine={false}
              width={34}
            />
            <Tooltip
              cursor={{ stroke: "var(--cursor)", strokeWidth: 1 }}
              content={<GraphTooltip />}
            />
            {/* music context first (drawn underneath), then body signals on top */}
            {[...music, ...body].map((s) => (
              <Line
                key={s.key}
                type="monotone"
                dataKey={s.key}
                stroke={s.color}
                strokeWidth={s.width}
                strokeDasharray={s.dash}
                dot={false}
                activeDot={s.group === "body" ? { r: 3, strokeWidth: 0 } : false}
                connectNulls
                isAnimationActive={false}
              />
            ))}
          </LineChart>
        </ResponsiveContainer>

        <div className="graph-legend">
          <LegendGroup title="Your body" items={body} />
          <LegendGroup title="The music" items={music} />
        </div>
      </div>

      <p className="muted small graph-caption">
        Arousal is the fused fast signal — expression shifts, movement
        {body.some((s) => s.key === "muse") ? ", and the Muse EEG band-power line" : ""}. Valence
        comes from facial expression (above 0 = pleasant). Shaded bands are the song's high-energy
        sections.
      </p>
    </div>
  );
}

function LegendGroup({ title, items }: { title: string; items: SeriesDef[] }) {
  if (items.length === 0) return null;
  return (
    <div className="legend-group">
      <span className="legend-title">{title}</span>
      {items.map((s) => (
        <span key={s.key} className="legend-item">
          <span
            className="legend-swatch"
            style={{ background: s.color, opacity: s.dash ? 0.7 : 1 }}
          />
          {s.label}
        </span>
      ))}
    </div>
  );
}

interface TooltipProps {
  active?: boolean;
  label?: number | string;
  payload?: { dataKey?: string | number; value?: number | null }[];
}

function GraphTooltip({ active, label, payload }: TooltipProps) {
  if (!active || !payload || payload.length === 0) return null;
  return (
    <div className="graph-tooltip">
      <div className="graph-tooltip-t">t = {label}s</div>
      {SERIES.filter((s) => payload.some((p) => p.dataKey === s.key && p.value != null)).map((s) => {
        const value = payload.find((p) => p.dataKey === s.key)?.value;
        if (value == null) return null;
        return (
          <div key={s.key} className="graph-tooltip-row">
            <span className="legend-swatch" style={{ background: s.color }} />
            <span className="graph-tooltip-label">{s.label}</span>
            <span className="graph-tooltip-value">{s.format(value)}</span>
          </div>
        );
      })}
    </div>
  );
}
