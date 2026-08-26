#!/usr/bin/env node
/**
 * CLI de construcao do banco local.
 *
 *   node --experimental-sqlite dist/ingest/build.js --years 2025,2026
 *   node --experimental-sqlite dist/ingest/build.js --years 2026 --countries 160 --flows import
 *
 * Baixa os arquivos oficiais do Comex Stat e monta o SQLite na maquina do usuario.
 * Nenhum dado e redistribuido por este pacote.
 */

import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import {
  bulkUrl, REF_URLS, LAYOUT, DELIMITER, SOURCE_ENCODING,
  classifyUrf, cleanUrfName, type Flow,
} from "../sources.js";
import { streamLines, head } from "../http.js";
import { dbPath, ensureSchema, setMeta } from "../db.js";

// ---------------------------------------------------------------- args

interface Args { years: number[]; flows: Flow[]; countries: number[] | null }

function parseArgs(argv: string[]): Args {
  const get = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const thisYear = new Date().getUTCFullYear();
  const years = (get("years") ?? `${thisYear - 1},${thisYear}`)
    .split(",").map((s) => Number(s.trim())).filter((n) => n >= 1997 && n <= thisYear + 1);
  const flows = (get("flows") ?? "import")
    .split(",").map((s) => s.trim()).filter((s): s is Flow => s === "import" || s === "export");
  const cRaw = get("countries");
  const countries = cRaw ? cRaw.split(",").map((s) => Number(s.trim())).filter(Number.isFinite) : null;
  if (!years.length) throw new Error("--years invalido (ex: --years 2025,2026)");
  if (!flows.length) throw new Error("--flows invalido (import,export)");
  return { years, flows, countries };
}

// ---------------------------------------------------------------- csv

/** Parser de linha CSV com aspas — usado nas tabelas de referencia (tem texto livre). */
function parseQuoted(line: string): string[] {
  const out: string[] = [];
  let cur = "", inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (ch === '"') {
      if (inQ && line[i + 1] === '"') { cur += '"'; i++; } else inQ = !inQ;
    } else if (ch === DELIMITER && !inQ) { out.push(cur); cur = ""; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

/** Split rapido para os arquivos de fato (sem texto livre, aspas so nos codigos). */
function parseFast(line: string): string[] {
  const parts = line.split(DELIMITER);
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i]!;
    if (p.charCodeAt(0) === 34) parts[i] = p.slice(1, p.charCodeAt(p.length - 1) === 34 ? -1 : undefined);
  }
  return parts;
}

async function headLastModified(url: string): Promise<string | null> {
  const h = await head(url);
  return h["last-modified"] ?? null;
}

// ---------------------------------------------------------------- refs

async function loadRefs(db: DatabaseSync): Promise<void> {
  process.stderr.write("[refs] paises...");
  const cn = db.prepare(`INSERT OR REPLACE INTO ref_country(code,name_pt,name_en,iso3) VALUES(?,?,?,?)`);
  db.exec("BEGIN");
  let first = true;
  for await (const line of streamLines(REF_URLS.country, SOURCE_ENCODING)) {
    if (first) { first = false; continue; }
    const f = parseQuoted(line);
    cn.run(Number(f[0]), f[3] ?? null, f[4] ?? null, f[2] ?? null);
  }
  db.exec("COMMIT");

  process.stderr.write(" modais...");
  const vi = db.prepare(`INSERT OR REPLACE INTO ref_via(code,name) VALUES(?,?)`);
  db.exec("BEGIN");
  first = true;
  for await (const line of streamLines(REF_URLS.via, SOURCE_ENCODING)) {
    if (first) { first = false; continue; }
    const f = parseQuoted(line);
    vi.run(Number(f[0]), f[1] ?? null);
  }
  db.exec("COMMIT");

  // URF: aqui nasce a correcao do modal — a classificacao do ponto de despacho.
  process.stderr.write(" URFs...");
  const uf = db.prepare(`INSERT OR REPLACE INTO ref_urf(code,name,kind) VALUES(?,?,?)`);
  db.exec("BEGIN");
  first = true;
  let airports = 0, seaports = 0, other = 0;
  for await (const line of streamLines(REF_URLS.urf, SOURCE_ENCODING)) {
    if (first) { first = false; continue; }
    const f = parseQuoted(line);
    const raw = f[1] ?? "";
    const kind = classifyUrf(raw);
    if (kind === "airport") airports++; else if (kind === "seaport") seaports++; else other++;
    uf.run(Number(f[0]), cleanUrfName(raw), kind);
  }
  db.exec("COMMIT");

  process.stderr.write(" NCM...");
  const nc = db.prepare(`INSERT OR REPLACE INTO ref_ncm(code,name_pt,name_en,sh6) VALUES(?,?,?,?)`);
  db.exec("BEGIN");
  first = true;
  for await (const line of streamLines(REF_URLS.ncm, SOURCE_ENCODING)) {
    if (first) { first = false; continue; }
    const f = parseQuoted(line);
    nc.run(f[0] ?? "", f[11] ?? null, f[13] ?? null, f[2] ?? null);
  }
  db.exec("COMMIT");

  process.stderr.write(
    ` ok (URF: ${airports} aeroportos, ${seaports} portos, ${other} outras)\n`,
  );
  setMeta(db, "urf_classification", JSON.stringify({ airports, seaports, other }));
}

// ---------------------------------------------------------------- facts

async function loadYear(db: DatabaseSync, flow: Flow, year: number, countries: number[] | null): Promise<number> {
  const url = bulkUrl(flow, year);
  const lastMod = await headLastModified(url);
  const L = LAYOUT[flow].idx;
  const keep = countries ? new Set(countries) : null;

  const ins = db.prepare(
    `INSERT INTO trade(flow,year,month,ncm,country,uf,via,urf,qty,net_kg,fob_usd,freight_usd,insurance_usd)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  );
  db.prepare(`DELETE FROM trade WHERE flow=? AND year=?`).run(flow, year);

  let n = 0, skipped = 0, first = true;
  db.exec("BEGIN");
  for await (const line of streamLines(url, SOURCE_ENCODING)) {
    if (first) { first = false; continue; }
    const f = parseFast(line);
    const country = Number(f[L.country]);
    if (keep && !keep.has(country)) { skipped++; continue; }
    ins.run(
      flow, Number(f[L.year]), Number(f[L.month]), f[L.ncm] ?? "", country,
      f[L.uf] ?? null, Number(f[L.via]), Number(f[L.urf]),
      Number(f[L.qty] ?? 0), Number(f[L.netKg] ?? 0), Number(f[L.fobUsd] ?? 0),
      L.freightUsd === null ? null : Number(f[L.freightUsd] ?? 0),
      L.insuranceUsd === null ? null : Number(f[L.insuranceUsd] ?? 0),
    );
    if (++n % 200_000 === 0) {
      db.exec("COMMIT"); db.exec("BEGIN");
      process.stderr.write(`\r[${flow} ${year}] ${n.toLocaleString("pt-BR")} linhas...`);
    }
  }
  db.exec("COMMIT");

  db.prepare(
    `INSERT OR REPLACE INTO ingest_log(flow,year,url,source_last_modified,rows,ingested_at)
     VALUES(?,?,?,?,?,datetime('now'))`,
  ).run(flow, year, url, lastMod, n);

  process.stderr.write(
    `\r[${flow} ${year}] ${n.toLocaleString("pt-BR")} linhas` +
      (skipped ? ` (${skipped.toLocaleString("pt-BR")} fora do filtro de pais)` : "") +
      ` — fonte: ${lastMod ?? "?"}\n`,
  );
  return n;
}

// ---------------------------------------------------------------- main

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const path = dbPath();
  mkdirSync(dirname(path), { recursive: true });

  process.stderr.write(
    `mcp-comex-brasil — construindo ${path}\n` +
      `  anos: ${args.years.join(", ")} | fluxos: ${args.flows.join(", ")}` +
      `${args.countries ? ` | paises: ${args.countries.join(", ")}` : " | todos os paises"}\n\n`,
  );

  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = OFF");   // build offline: seguranca vem do rebuild
  ensureSchema(db);

  await loadRefs(db);
  let total = 0;
  for (const flow of args.flows) {
    for (const year of args.years) total += await loadYear(db, flow, year, args.countries);
  }

  setMeta(db, "built_at", new Date().toISOString());
  setMeta(db, "scope", JSON.stringify(args));
  db.exec("ANALYZE");
  db.close();

  process.stderr.write(`\nok — ${total.toLocaleString("pt-BR")} linhas de fato no banco.\n`);
}

main().catch((e) => {
  process.stderr.write(`\nerro: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
