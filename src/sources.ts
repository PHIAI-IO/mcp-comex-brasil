/**
 * Fontes oficiais do Comex Stat (Secretaria de Comercio Exterior / Receita Federal).
 *
 * Decisao de arquitetura: usamos o **CSV bulk**, nao a API.
 *   - CSV bulk (balanca.economia.gov.br)  -> estavel, sem rate-limit, dado completo
 *   - API (api-comexstat.mdic.gov.br)     -> rate-limit agressivo (HTTP 429), detail limitado;
 *                                            GET /general devolve 403, POST com o mesmo filtro funciona
 *                                            (verificado 2026-09-24) — quem usar a API, use POST
 *   - Site (comexstat.mdic.gov.br)        -> HTTP 403
 *
 * Nada e redistribuido: o servidor baixa da fonte oficial na maquina do usuario.
 */

export const BULK_BASE = "https://balanca.economia.gov.br/balanca/bd";

/** Arquivo anual de importacao ou exportacao, por NCM. */
export function bulkUrl(flow: Flow, year: number): string {
  const prefix = flow === "import" ? "IMP" : "EXP";
  return `${BULK_BASE}/comexstat-bd/ncm/${prefix}_${year}.csv`;
}

/** Tabelas de referencia (codigo -> nome). */
export const REF_URLS = {
  country: `${BULK_BASE}/tabelas/PAIS.csv`,
  via: `${BULK_BASE}/tabelas/VIA.csv`,
  urf: `${BULK_BASE}/tabelas/URF.csv`,
  ncm: `${BULK_BASE}/tabelas/NCM.csv`,
} as const;

export type Flow = "import" | "export";

/**
 * IMPORTANTE: os arquivos vem em **ISO-8859-1 (Latin-1)**, nao UTF-8.
 * Decodificar como UTF-8 corrompe todo acento ("Nao Definido" -> "N�o Definido").
 */
export const SOURCE_ENCODING = "latin1" as const;

/** Separador de campos dos CSV oficiais. */
export const DELIMITER = ";";

/**
 * Layout dos arquivos de fato (posicao 0-based apos remover as aspas).
 *
 * IMP tem 13 colunas e inclui VL_FRETE + VL_SEGURO — frete e seguro declarados
 * na aduana. E o campo mais valioso do dataset e os resumos publicados o descartam.
 * EXP tem 11 colunas e NAO tem frete/seguro.
 */
export const LAYOUT = {
  import: {
    columns: 13,
    idx: {
      year: 0, month: 1, ncm: 2, unit: 3, country: 4, uf: 5, via: 6, urf: 7,
      qty: 8, netKg: 9, fobUsd: 10, freightUsd: 11, insuranceUsd: 12,
    },
  },
  export: {
    columns: 11,
    idx: {
      year: 0, month: 1, ncm: 2, unit: 3, country: 4, uf: 5, via: 6, urf: 7,
      qty: 8, netKg: 9, fobUsd: 10, freightUsd: null, insuranceUsd: null,
    },
  },
} as const;

/** Codigos de modal (CO_VIA) relevantes. Fonte: tabela VIA.csv oficial. */
export const VIA = {
  NAO_DECLARADA: 0,
  MARITIMA: 1,
  FLUVIAL: 2,
  LACUSTRE: 3,
  AEREA: 4,
  POSTAL: 5,
  FERROVIARIA: 6,
  RODOVIARIA: 7,
  CONDUTO: 8,
  MEIOS_PROPRIOS: 9,
  ENTRADA_SAIDA_FICTA: 10,
  COURIER: 11,
  EM_MAOS: 12,
  POR_REBOQUE: 13,
  DUTOS: 14,
  VICINAL_FRONTEIRICO: 15,
  DESCONHECIDA: 99,
} as const;

/** Os dois canais pelos quais entra encomenda internacional. Ver caveat `simplified_regime_absent`. */
export const PARCEL_VIAS = [VIA.POSTAL, VIA.COURIER];

export type UrfKind = "airport" | "seaport" | "other";

/**
 * Classifica a unidade da Receita (URF) onde a carga foi despachada.
 *
 * Por que isto existe: `CO_VIA` (modal) NAO e confiavel a nivel de registro —
 * ver o caveat `via_contamination`. A correcao usa o **ponto de despacho** como
 * arbitro, e para isso basta identificar aeroporto com seguranca.
 *
 * Desenho deliberado: so `airport` precisa ser exato (a regra da correcao depende
 * dele) e "AEROPORTO" no nome oficial e um marcador limpo. `seaport` serve apenas
 * para EXPLICAR a contaminacao, nao para corrigi-la — por isso uma lista incompleta
 * de portos nao compromete o resultado. O que nao se reconhece fica `other`,
 * nunca chutado.
 */
export function classifyUrf(nameRaw: string): UrfKind {
  // O nome oficial vem prefixado com o proprio codigo: "0817700 - AEROPORTO ..."
  const name = nameRaw.replace(/^\s*\d+\s*-\s*/, "").toUpperCase();

  if (name.includes("AEROPORTO")) return "airport";

  // Marcadores de porto maritimo/fluvial. Lista nao-exaustiva por desenho (ver acima).
  const SEAPORT_MARKERS = [
    "PORTO", "ITAJAI", "PARANAGUA", "SANTOS", "ITAGUAI", "SUAPE", "PECEM",
    "RIO GRANDE", "NAVEGANTES", "SEPETIBA", "IMBITUBA", "ARATU", "ITAQUI",
    "VILA DO CONDE", "SAO FRANCISCO DO SUL", "TUBARAO", "MUCURIPE",
    "ANGRA DOS REIS", "SAO SEBASTIAO", "BARRA DOS COQUEIROS",
  ];
  if (SEAPORT_MARKERS.some((m) => name.includes(m))) return "seaport";

  return "other";
}

/** Nome limpo da URF, sem o prefixo numerico. */
export function cleanUrfName(nameRaw: string): string {
  return nameRaw.replace(/^\s*\d+\s*-\s*/, "").trim();
}
