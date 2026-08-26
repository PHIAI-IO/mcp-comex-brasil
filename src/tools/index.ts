/**
 * As tools.
 *
 * Regra que atravessa todas: nenhuma resposta sai sem (a) procedencia e
 * (b) os caveats que se aplicam aquela consulta. Um numero sem essas duas
 * coisas nao e verificavel, e verificabilidade e o proposito do servidor.
 *
 * Nenhuma tool consulta a coluna `via` crua — todas usam a vista `trade_channel`,
 * onde a correcao do modal existe em um lugar so.
 */

import type { DatabaseSync } from "node:sqlite";
import { openDb, provenance } from "../db.js";
import { renderCaveats, CAVEATS, type QueryShape, type Lang } from "../caveats.js";

type Row = Record<string, unknown>;

// --------------------------------------------------------------- helpers

const CHANNELS = ["air", "sea", "parcel", "road", "air_declared_at_port", "air_declared_inland", "other"] as const;
const GROUPABLE = {
  year: "year", month: "month", channel: "channel", country: "country",
  ncm: "ncm", urf: "urf", uf: "uf", urf_kind: "urf_kind",
} as const;
type GroupKey = keyof typeof GROUPABLE;

/** Whitelist de colunas de agrupamento — nunca interpolar entrada do usuario em SQL. */
function safeGroups(keys: unknown): GroupKey[] {
  if (!Array.isArray(keys)) return [];
  return keys.filter((k): k is GroupKey => typeof k === "string" && k in GROUPABLE);
}

/** Resolve nome de pais para codigo (aceita codigo, nome PT ou EN, parcial). */
function resolveCountries(db: DatabaseSync, input: unknown): { codes: number[]; unresolved: string[] } {
  if (input === undefined || input === null) return { codes: [], unresolved: [] };
  const list = Array.isArray(input) ? input : [input];
  const codes: number[] = [];
  const unresolved: string[] = [];
  const byName = db.prepare(
    `SELECT code FROM ref_country
     WHERE UPPER(name_pt) LIKE UPPER(?) OR UPPER(name_en) LIKE UPPER(?) OR UPPER(iso3) = UPPER(?)
     ORDER BY LENGTH(name_pt) LIMIT 5`,
  );
  for (const raw of list) {
    const s = String(raw).trim();
    if (/^\d+$/.test(s)) { codes.push(Number(s)); continue; }
    const hits = byName.all(`%${s}%`, `%${s}%`, s) as Row[];
    if (hits.length) codes.push(...hits.map((h) => Number(h.code)));
    else unresolved.push(s);
  }
  return { codes: [...new Set(codes)], unresolved };
}

interface Filters {
  flow: "import" | "export";
  years?: number[];
  months?: number[];
  countryCodes?: number[];
  ncm?: string;
  channels?: string[];
}

function buildWhere(f: Filters): { sql: string; params: (string | number)[] } {
  const w: string[] = ["flow = ?"];
  const p: (string | number)[] = [f.flow];
  if (f.years?.length)  { w.push(`year IN (${f.years.map(() => "?").join(",")})`);   p.push(...f.years); }
  if (f.months?.length) { w.push(`month IN (${f.months.map(() => "?").join(",")})`); p.push(...f.months); }
  if (f.countryCodes?.length) {
    w.push(`country IN (${f.countryCodes.map(() => "?").join(",")})`); p.push(...f.countryCodes);
  }
  if (f.ncm) { w.push("ncm LIKE ?"); p.push(`${f.ncm.replace(/\D/g, "")}%`); }
  if (f.channels?.length) {
    w.push(`channel IN (${f.channels.map(() => "?").join(",")})`); p.push(...f.channels);
  }
  return { sql: w.join(" AND "), params: p };
}

function labelJoins(groups: GroupKey[]): { select: string[]; join: string } {
  const sel: string[] = [];
  let join = "";
  if (groups.includes("country")) {
    sel.push("c.name_pt AS country_name");
    join += " LEFT JOIN ref_country c ON c.code = t.country";
  }
  if (groups.includes("ncm")) {
    sel.push("n.name_pt AS ncm_name");
    join += " LEFT JOIN ref_ncm n ON n.code = t.ncm";
  }
  if (groups.includes("urf")) {
    sel.push("u.name AS urf_name", "u.kind AS urf_kind_label");
    join += " LEFT JOIN ref_urf u ON u.code = t.urf";
  }
  return { select: sel, join };
}

// --------------------------------------------------------------- 1. trade_flow

export function tradeFlow(args: Row, lang: Lang) {
  const db = openDb();
  try {
    const flow = args.flow === "export" ? "export" : "import";
    const years = Array.isArray(args.years) ? args.years.map(Number).filter(Number.isFinite) : [];
    const months = Array.isArray(args.months) ? args.months.map(Number).filter(Number.isFinite) : [];
    const { codes, unresolved } = resolveCountries(db, args.countries);
    const groups = safeGroups(args.group_by).length ? safeGroups(args.group_by) : (["year"] as GroupKey[]);
    const channels = Array.isArray(args.channel)
      ? (args.channel as string[]).filter((c) => (CHANNELS as readonly string[]).includes(c))
      : typeof args.channel === "string" && args.channel !== "all"
        ? [args.channel].filter((c) => (CHANNELS as readonly string[]).includes(c))
        : [];
    const limit = Math.min(Number(args.limit) || 50, 500);

    const { sql: where, params } = buildWhere({
      flow, years, months, countryCodes: codes, ncm: args.ncm as string | undefined, channels,
    });
    const { select: extraSel, join } = labelJoins(groups);
    const groupCols = groups.map((g) => `t.${GROUPABLE[g]}`);

    const rows = db.prepare(
      `SELECT ${groupCols.join(", ")}${extraSel.length ? ", " + extraSel.join(", ") : ""},
              COUNT(*) AS records,
              ROUND(SUM(t.net_kg), 0)  AS net_kg,
              ROUND(SUM(t.fob_usd), 0) AS fob_usd,
              ROUND(SUM(t.fob_usd) / NULLIF(SUM(t.net_kg), 0), 2) AS usd_per_kg
       FROM trade_channel t${join}
       WHERE ${where.replace(/\b(flow|year|month|country|ncm|channel)\b/g, "t.$1")}
       GROUP BY ${groupCols.join(", ")}
       ORDER BY fob_usd DESC
       LIMIT ?`,
    ).all(...params, limit) as Row[];

    const monthsInResult = groups.includes("month")
      ? new Set(rows.map((r) => `${r.year ?? ""}-${r.month}`)).size
      : (years.length ? years.length * 12 : 0);

    const shape: QueryShape = {
      flow, byVia: groups.includes("channel"),
      vias: channels.includes("air") ? [4] : undefined,
      monthsInResult,
    };

    return {
      query: { flow, years, months, countries: codes, ncm: args.ncm ?? null, channels: channels.length ? channels : "all", group_by: groups },
      rows,
      unresolved_countries: unresolved,
      caveats: renderCaveats(shape, lang),
      provenance: provenance(db),
    };
  } finally { db.close(); }
}

// --------------------------------------------------------------- 2. freight_cost

export function freightCost(args: Row, lang: Lang) {
  const db = openDb();
  try {
    const years = Array.isArray(args.years) ? args.years.map(Number).filter(Number.isFinite) : [];
    const months = Array.isArray(args.months) ? args.months.map(Number).filter(Number.isFinite) : [];
    const { codes, unresolved } = resolveCountries(db, args.countries);
    const extra = safeGroups(args.group_by).filter((g) => g !== "channel");
    const groups: GroupKey[] = ["channel", ...extra];

    // Frete/seguro so existem nos arquivos de IMPORTACAO.
    const { sql: where, params } = buildWhere({
      flow: "import", years, months, countryCodes: codes, ncm: args.ncm as string | undefined,
    });
    const groupCols = groups.map((g) => `t.${GROUPABLE[g]}`);

    const rows = db.prepare(
      `SELECT ${groupCols.join(", ")},
              COUNT(*) AS records,
              ROUND(SUM(t.net_kg), 0)      AS net_kg,
              ROUND(SUM(t.fob_usd), 0)     AS fob_usd,
              ROUND(SUM(t.freight_usd), 0) AS freight_usd,
              ROUND(SUM(t.freight_usd) / NULLIF(SUM(t.net_kg), 0), 3)     AS freight_usd_per_kg,
              ROUND(100.0 * SUM(t.freight_usd) / NULLIF(SUM(t.fob_usd), 0), 2)   AS freight_pct_of_fob,
              ROUND(100.0 * SUM(t.insurance_usd) / NULLIF(SUM(t.fob_usd), 0), 3) AS insurance_pct_of_fob,
              ROUND(SUM(t.fob_usd) / NULLIF(SUM(t.net_kg), 0), 2)         AS usd_per_kg
       FROM trade_channel t
       WHERE ${where.replace(/\b(flow|year|month|country|ncm)\b/g, "t.$1")}
       GROUP BY ${groupCols.join(", ")}
       ORDER BY net_kg DESC`,
    ).all(...params) as Row[];

    const monthsInResult = groups.includes("month")
      ? new Set(rows.map((r) => `${r.year ?? ""}-${r.month}`)).size : 0;

    return {
      note_pt:
        "Frete e seguro DECLARADOS a aduana (VL_FRETE / VL_SEGURO). O canal 'air' ja esta " +
        "corrigido pelo ponto de despacho; 'air_declared_at_port' e o bloco contaminado, " +
        "exposto de proposito para inspecao.",
      note_en:
        "Freight and insurance as DECLARED to customs (VL_FRETE / VL_SEGURO). The 'air' " +
        "channel is already corrected by clearance point; 'air_declared_at_port' is the " +
        "contaminated block, exposed on purpose for inspection.",
      query: { flow: "import", years, months, countries: codes, ncm: args.ncm ?? null, group_by: groups },
      rows,
      unresolved_countries: unresolved,
      caveats: renderCaveats({ flow: "import", freight: true, byVia: true, monthsInResult }, lang),
      provenance: provenance(db),
    };
  } finally { db.close(); }
}

// --------------------------------------------------------------- 3. data_caveats

export function dataCaveats(args: Row, lang: Lang) {
  const id = typeof args.id === "string" ? args.id : null;
  const list = id ? CAVEATS.filter((c) => c.id === id) : CAVEATS;
  return {
    purpose_pt:
      "Defeitos conhecidos do dataset, com evidencia medida e procedencia. Consulte ANTES " +
      "de publicar qualquer numero derivado do Comex Stat.",
    purpose_en:
      "Known defects of the dataset, with measured evidence and provenance. Consult BEFORE " +
      "publishing any figure derived from Comex Stat.",
    count: list.length,
    caveats: list.map((c) => ({
      id: c.id,
      severity: c.severity,
      dataset: c.dataset,
      title: lang === "pt" ? c.title_pt : c.title_en,
      description: lang === "pt" ? c.description_pt : c.description_en,
      evidence: lang === "pt" ? c.evidence_pt : c.evidence_en,
      correction: c.correction
        ? {
            applied_automatically: c.correction.applied,
            rule: lang === "pt" ? c.correction.rule_pt : c.correction.rule_en,
          }
        : null,
      verified: c.verified,
    })),
    checklist_pt: [
      "O modal foi cruzado com o tipo de URF de despacho?",
      "A comparacao interanual usa a MESMA janela de meses e a MESMA correcao?",
      "O resultado declara que mede comercio FORMAL (sem encomenda)?",
      "A ordem de magnitude foi conferida contra uma segunda fonte?",
    ],
    checklist_en: [
      "Was transport mode cross-referenced with the clearance-point type?",
      "Does the year-over-year comparison use the SAME month window and the SAME correction?",
      "Does the output state that it measures FORMAL trade (parcels excluded)?",
      "Was the order of magnitude checked against a second source?",
    ],
  };
}

// --------------------------------------------------------------- 4. resolve_code

export function resolveCode(args: Row) {
  const db = openDb();
  try {
    const kind = String(args.kind ?? "country");
    const q = String(args.query ?? "").trim();
    const limit = Math.min(Number(args.limit) || 20, 100);
    const like = `%${q}%`;
    let rows: Row[] = [];

    if (kind === "country") {
      rows = db.prepare(
        `SELECT code, name_pt, name_en, iso3 FROM ref_country
         WHERE CAST(code AS TEXT) = ? OR UPPER(name_pt) LIKE UPPER(?) OR UPPER(name_en) LIKE UPPER(?)
         ORDER BY LENGTH(name_pt) LIMIT ?`,
      ).all(q, like, like, limit) as Row[];
    } else if (kind === "ncm") {
      rows = db.prepare(
        `SELECT code, name_pt, name_en, sh6 FROM ref_ncm
         WHERE code LIKE ? OR UPPER(name_pt) LIKE UPPER(?) OR UPPER(name_en) LIKE UPPER(?)
         ORDER BY code LIMIT ?`,
      ).all(`${q}%`, like, like, limit) as Row[];
    } else if (kind === "via") {
      rows = db.prepare(
        `SELECT code, name FROM ref_via
         WHERE CAST(code AS TEXT) = ? OR UPPER(name) LIKE UPPER(?) ORDER BY code LIMIT ?`,
      ).all(q, like, limit) as Row[];
    } else if (kind === "urf") {
      rows = db.prepare(
        `SELECT code, name, kind FROM ref_urf
         WHERE CAST(code AS TEXT) = ? OR UPPER(name) LIKE UPPER(?) ORDER BY name LIMIT ?`,
      ).all(q, like, limit) as Row[];
    }

    return {
      kind, query: q, count: rows.length, matches: rows,
      hint_pt:
        kind === "via"
          ? "Lembre: o codigo de modal NAO e confiavel sozinho. Ver o caveat via_contamination."
          : undefined,
    };
  } finally { db.close(); }
}
