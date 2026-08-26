import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Caminho do banco local. Sobrescrevivel por env para instalacoes custom. */
export function dbPath(): string {
  return process.env.COMEX_DB ?? resolve(__dirname, "../data/comex.db");
}

export class DbMissingError extends Error {
  constructor(path: string) {
    super(
      `Banco local nao encontrado em ${path}.\n` +
        `Construa com:  npm run db:build -- --years 2025,2026\n` +
        `(baixa os arquivos oficiais do Comex Stat e monta o SQLite; nada e redistribuido)`,
    );
    this.name = "DbMissingError";
  }
}

export function openDb(readonly = true): DatabaseSync {
  const path = dbPath();
  if (readonly && !existsSync(path)) throw new DbMissingError(path);
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  return db;
}

/**
 * Schema.
 *
 * O grao original e preservado (ano, mes, NCM, pais, UF, modal, URF) — agregar no
 * ingest fecharia perguntas que ainda nao sabemos que vamos fazer.
 *
 * A CORRECAO do modal vive numa VIEW unica (`trade_channel`). Toda tool consulta
 * `channel` e nunca `via` cru, para que a regra exista em um lugar so.
 */
export const SCHEMA = `
CREATE TABLE IF NOT EXISTS trade (
  flow           TEXT    NOT NULL,        -- 'import' | 'export'
  year           INTEGER NOT NULL,
  month          INTEGER NOT NULL,
  ncm            TEXT    NOT NULL,
  country        INTEGER NOT NULL,
  uf             TEXT,
  via            INTEGER NOT NULL,        -- CO_VIA cru — NAO usar direto, ver trade_channel
  urf            INTEGER NOT NULL,
  qty            REAL,
  net_kg         REAL,
  fob_usd        REAL,
  freight_usd    REAL,                    -- so import
  insurance_usd  REAL                     -- so import
);

CREATE INDEX IF NOT EXISTS ix_trade_main    ON trade(flow, year, country, ncm);
CREATE INDEX IF NOT EXISTS ix_trade_via     ON trade(flow, year, via);
CREATE INDEX IF NOT EXISTS ix_trade_month   ON trade(flow, year, month);
CREATE INDEX IF NOT EXISTS ix_trade_country ON trade(country, flow, year);

CREATE TABLE IF NOT EXISTS ref_country (
  code INTEGER PRIMARY KEY, name_pt TEXT, name_en TEXT, iso3 TEXT
);
CREATE TABLE IF NOT EXISTS ref_via (
  code INTEGER PRIMARY KEY, name TEXT
);
CREATE TABLE IF NOT EXISTS ref_urf (
  code INTEGER PRIMARY KEY, name TEXT, kind TEXT   -- kind: airport | seaport | other
);
CREATE TABLE IF NOT EXISTS ref_ncm (
  code TEXT PRIMARY KEY, name_pt TEXT, name_en TEXT, sh6 TEXT
);

-- Procedencia: de onde saiu cada carga e quando. Uma resposta sem procedencia
-- nao e verificavel, e verificabilidade e o ponto deste servidor.
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY, value TEXT, updated_at TEXT
);
CREATE TABLE IF NOT EXISTS ingest_log (
  flow TEXT, year INTEGER, url TEXT, source_last_modified TEXT,
  rows INTEGER, ingested_at TEXT,
  PRIMARY KEY (flow, year)
);
`;

/**
 * A vista que corrige o modal.
 *
 *   air          -> CO_VIA=04 despachado em AEROPORTO   (o unico "aereo" defensavel)
 *   air_declared_at_port -> CO_VIA=04 despachado em PORTO   (o bloco contaminado)
 *   sea          -> CO_VIA=01
 *   parcel       -> CO_VIA em (05,11)                   (praticamente vazio — ver caveat)
 *   road/other   -> resto
 */
export const VIEWS = `
DROP VIEW IF EXISTS trade_channel;
CREATE VIEW trade_channel AS
SELECT
  t.*,
  COALESCE(u.kind, 'other') AS urf_kind,
  CASE
    WHEN t.via = 4  AND COALESCE(u.kind,'other') = 'airport' THEN 'air'
    WHEN t.via = 4  AND COALESCE(u.kind,'other') = 'seaport' THEN 'air_declared_at_port'
    WHEN t.via = 4                                            THEN 'air_declared_inland'
    WHEN t.via = 1                                            THEN 'sea'
    WHEN t.via IN (5, 11)                                     THEN 'parcel'
    WHEN t.via = 7                                            THEN 'road'
    ELSE 'other'
  END AS channel
FROM trade t
LEFT JOIN ref_urf u ON u.code = t.urf;
`;

export function ensureSchema(db: DatabaseSync): void {
  db.exec(SCHEMA);
  db.exec(VIEWS);
}

export function setMeta(db: DatabaseSync, key: string, value: string): void {
  db.prepare(
    `INSERT INTO meta(key,value,updated_at) VALUES(?,?,datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`,
  ).run(key, value);
}

export interface Provenance {
  source: string;
  files: Array<{ flow: string; year: number; rows: number; source_last_modified: string | null; ingested_at: string }>;
}

/** O que sustenta a resposta: arquivos, versao da fonte e data de ingestao. */
export function provenance(db: DatabaseSync): Provenance {
  const rows = db
    .prepare(
      `SELECT flow, year, rows, source_last_modified, ingested_at
       FROM ingest_log ORDER BY flow, year`,
    )
    .all() as Array<Record<string, unknown>>;
  return {
    source:
      "Comex Stat bulk (Secretaria de Comercio Exterior / Receita Federal) — balanca.economia.gov.br",
    files: rows.map((r) => ({
      flow: String(r.flow),
      year: Number(r.year),
      rows: Number(r.rows),
      source_last_modified: r.source_last_modified ? String(r.source_last_modified) : null,
      ingested_at: String(r.ingested_at),
    })),
  };
}
