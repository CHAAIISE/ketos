import type { DepthSample } from "@/lib/near/types";

/** The x axis covers the sell sizes the keeper quotes, log-spaced. */
export const AXIS_MIN_USD = 1_000;
export const AXIS_MAX_USD = 1_000_000;
/** Exit capacity is the largest size whose impact stays at or under this. */
export const IMPACT_CAP_BPS = 100;

export type Tone = "void" | "deep" | "thin" | "over" | "none" | "label" | "note" | "blank";

export interface Cell {
  ch: string;
  tone: Tone;
}

export type Row = Cell[];

export interface AsciiBand {
  label: string;
  /** Null when the asset has no depth sample on chain yet. */
  samples: readonly DepthSample[] | null;
}

export interface AsciiAnnotation {
  /** Sell size the annotation points at. */
  sizeUsd: number;
  text: string;
}

export interface AsciiOptions {
  cols: number;
  rowsPerBand: number;
  /** Drawn top to bottom; the first one points furthest right. */
  annotations: readonly AsciiAnnotation[];
}

/** Characters before the first grid column (asset label). */
export const LABEL_WIDTH = 7;
/** From thin to deep. */
const DENSITY = [":", "-", "=", "+", "*", "#"] as const;

const LOG_SPAN = Math.log(AXIS_MAX_USD / AXIS_MIN_USD);

export function columnSizeUsd(col: number, cols: number): number {
  return AXIS_MIN_USD * Math.exp((LOG_SPAN * col) / (cols - 1));
}

export function sizeColumn(sizeUsd: number, cols: number): number {
  const raw = Math.round((Math.log(sizeUsd / AXIS_MIN_USD) / LOG_SPAN) * (cols - 1));
  return Math.min(cols - 1, Math.max(0, raw));
}

/**
 * Impact of selling `sizeUsd`, interpolated on log size between two quoted sizes.
 * Returns null when the next quoted size found no liquidity: nothing between the last
 * liquid quote and that one is assumed sellable. Undefined past the largest quote.
 */
export function impactAt(samples: readonly DepthSample[], sizeUsd: number): number | null | undefined {
  const sorted = [...samples].sort((a, b) => a.size_usd - b.size_usd);
  const upper = sorted.findIndex((s) => s.size_usd >= sizeUsd * 0.999);
  if (upper === -1) return undefined;
  const hi = sorted[upper];
  if (hi.impact_bps === null) return null;
  const lo = upper > 0 ? sorted[upper - 1] : undefined;
  if (!lo || lo.impact_bps === null || hi.size_usd <= lo.size_usd) return hi.impact_bps;
  const t = Math.log(sizeUsd / lo.size_usd) / Math.log(hi.size_usd / lo.size_usd);
  return lo.impact_bps + (hi.impact_bps - lo.impact_bps) * Math.min(1, Math.max(0, t));
}

/** Smallest quoted size that found no liquidity, if any. */
export function firstDrySize(samples: readonly DepthSample[]): number | null {
  const dry = samples.filter((s) => s.impact_bps === null).map((s) => s.size_usd);
  return dry.length ? Math.min(...dry) : null;
}

/** "$1k", "$250k", "$1M". */
export function compactUsd(value: number): string {
  if (value >= 1_000_000) return `$${trim(value / 1_000_000)}M`;
  if (value >= 1_000) return `$${trim(value / 1_000)}k`;
  return `$${Math.round(value)}`;
}

function trim(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1).replace(/\.0$/, "");
}

function blankRow(width: number, tone: Tone = "blank"): Row {
  return Array.from({ length: width }, () => ({ ch: " ", tone }));
}

function write(row: Row, start: number, text: string, tone: Tone) {
  for (let i = 0; i < text.length; i++) {
    const at = start + i;
    if (at >= 0 && at < row.length) row[at] = { ch: text[i], tone };
  }
}

function bandColumn(samples: readonly DepthSample[] | null, col: number, cols: number, rows: number): Cell[] {
  const cells: Cell[] = Array.from({ length: rows }, () => ({ ch: "·", tone: "void" }));
  if (!samples) return cells;
  const impact = impactAt(samples, columnSizeUsd(col, cols));
  if (impact === undefined) return cells;
  const bottom = rows - 1;
  if (impact === null) {
    cells[bottom] = { ch: "·", tone: "none" };
    return cells;
  }
  if (impact > IMPACT_CAP_BPS) {
    cells[bottom] = { ch: ":", tone: "over" };
    return cells;
  }
  const score = 1 - Math.max(0, impact) / IMPACT_CAP_BPS;
  const height = Math.max(1, Math.ceil(score * rows));
  const base = Math.round(score * (DENSITY.length - 1));
  const tone: Tone = score >= 0.6 ? "deep" : "thin";
  for (let depth = 0; depth < height; depth++) {
    const fade = depth === 0 ? 2 : depth === 1 ? 1 : 0;
    cells[bottom - (height - 1 - depth)] = { ch: DENSITY[Math.max(0, base - fade)], tone };
  }
  return cells;
}

function annotationRows(annotations: readonly AsciiAnnotation[], cols: number): Row[] {
  const width = LABEL_WIDTH + cols;
  const rows: Row[] = [];
  const anchors = annotations.map((a) => LABEL_WIDTH + sizeColumn(a.sizeUsd, cols));
  annotations.forEach((annotation, index) => {
    const row = blankRow(width);
    const anchor = anchors[index];
    const left = `${annotation.text} -.`;
    if (anchor - left.length + 1 >= 0) {
      write(row, anchor - left.length + 1, left, "note");
    } else {
      write(row, anchor, `.- ${annotation.text}`, "note");
    }
    for (const earlier of anchors.slice(0, index)) {
      if (row[earlier].ch === " ") row[earlier] = { ch: "|", tone: "note" };
    }
    rows.push(row);
  });
  if (rows.length) {
    const tail = blankRow(width);
    for (const anchor of anchors) tail[anchor] = { ch: "|", tone: "note" };
    rows.push(tail);
  }
  return rows;
}

function axisRow(cols: number): Row {
  const row = blankRow(LABEL_WIDTH + cols);
  const ticks = [1_000, 10_000, 100_000, 1_000_000];
  ticks.forEach((size, index) => {
    const label = compactUsd(size);
    const col = LABEL_WIDTH + sizeColumn(size, cols);
    const start =
      index === 0 ? col : index === ticks.length - 1 ? col - label.length + 1 : col - Math.floor(label.length / 2);
    write(row, start, label, "note");
  });
  return row;
}

/** Character grid of sellable size per asset: taller and denser where the exit is deeper. */
export function buildAsciiDepth(bands: readonly AsciiBand[], options: AsciiOptions): Row[] {
  const { cols, rowsPerBand } = options;
  const width = LABEL_WIDTH + cols;
  const rows: Row[] = annotationRows(options.annotations, cols);
  bands.forEach((band, index) => {
    if (index > 0) rows.push(blankRow(width));
    const columns = Array.from({ length: cols }, (_, col) => bandColumn(band.samples, col, cols, rowsPerBand));
    for (let r = 0; r < rowsPerBand; r++) {
      const row = blankRow(width);
      if (r === rowsPerBand - 1) write(row, 0, band.label.padEnd(LABEL_WIDTH - 1).slice(0, LABEL_WIDTH - 1), "label");
      for (let col = 0; col < cols; col++) row[LABEL_WIDTH + col] = columns[col][r];
      rows.push(row);
    }
  });
  rows.push(blankRow(width));
  rows.push(axisRow(cols));
  return rows;
}

/** Runs of identical tone, so a row renders as a handful of spans. */
export function toneRuns(row: Row): { tone: Tone; text: string }[] {
  const runs: { tone: Tone; text: string }[] = [];
  for (const cell of row) {
    const last = runs[runs.length - 1];
    const tone = cell.ch === " " ? (last?.tone ?? "blank") : cell.tone;
    if (last && last.tone === tone) last.text += cell.ch;
    else runs.push({ tone, text: cell.ch });
  }
  return runs;
}
