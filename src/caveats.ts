/**
 * REGISTRO DE ARMADILHAS DO DATASET  —  o nucleo deste projeto.
 *
 * A premissa: um servidor MCP que so "expoe" o dado entrega ao agente uma API
 * limpa para um numero errado. A encanacao nao sabe que o campo mente.
 *
 * Aqui cada defeito conhecido e uma entrada declarativa com:
 *   - a regra de quando ele se aplica a uma consulta
 *   - a evidencia quantificada de quanto custa ignorar
 *   - a correcao (quando existe) e se ela foi aplicada
 *   - a procedencia: quando e como foi verificado
 *
 * Somar um defeito novo = somar uma entrada aqui. Nunca editar codigo de tool.
 */

import { VIA, PARCEL_VIAS } from "./sources.js";

export type Severity = "critical" | "warning" | "info";

/** O que a tool esta perguntando — o registro decide o que se aplica a isto. */
export interface QueryShape {
  flow: "import" | "export";
  /** modais explicitamente filtrados (CO_VIA) */
  vias?: number[];
  /** a consulta agrupa ou distingue por modal? */
  byVia?: boolean;
  /** a consulta pede frete/seguro declarado? */
  freight?: boolean;
  /** numero de meses distintos que a resposta vai conter */
  monthsInResult?: number;
  /** a consulta e sobre encomenda / e-commerce / remessa? */
  parcelIntent?: boolean;
}

export interface Correction {
  /** aplicada automaticamente pelo servidor, ou apenas recomendada? */
  applied: boolean;
  rule_pt: string;
  rule_en: string;
}

export interface Caveat {
  id: string;
  dataset: string;
  severity: Severity;
  title_pt: string;
  title_en: string;
  description_pt: string;
  description_en: string;
  /** o que o numero ingenuo erra, com magnitude medida */
  evidence_pt: string;
  evidence_en: string;
  correction?: Correction;
  /** quando e sobre que amostra foi verificado — procedencia, nao opiniao */
  verified: string;
  applies: (q: QueryShape) => boolean;
}

export const CAVEATS: Caveat[] = [
  {
    id: "via_contamination",
    dataset: "comex-stat/ncm",
    severity: "critical",
    title_pt: "O campo de modal (CO_VIA) nao e confiavel a nivel de registro",
    title_en: "The transport-mode field (CO_VIA) is unreliable at record level",
    description_pt:
      "Filtrar CO_VIA='04' (AEREA) nao identifica carga aerea. Uma parte substancial " +
      "desses registros e despachada em portos maritimos e corresponde a mercadoria que " +
      "nao voa. O arbitro confiavel e o ponto de despacho (CO_URF), nao o modal declarado.",
    description_en:
      "Filtering CO_VIA='04' (AIR) does not identify air cargo. A substantial share of " +
      "those records clears at seaports and consists of goods that do not fly. The " +
      "reliable arbiter is the clearance point (CO_URF), not the declared mode.",
    evidence_pt:
      "China -> Brasil, jan-jul/2026: dos 139.574.284 kg marcados como AEREA, apenas " +
      "33.993.130 kg (24%) despacharam em aeroporto. 89.700.794 kg despacharam em portos — " +
      "a maior unidade e o Porto de Paranagua e as maiores mercadorias por peso sao sulfato " +
      "de amonio (NCM 31022100) e fertilizantes fosfaticos (31039090), a US$0,29/kg de frete. " +
      "Sem corrigir: peso aereo 4,1x inflado e frete/kg 70% subestimado (US$3,21 em vez de US$10,81).",
    evidence_en:
      "China -> Brazil, Jan-Jul 2026: of 139,574,284 kg coded as AIR, only 33,993,130 kg " +
      "(24%) cleared at an airport. 89,700,794 kg cleared at seaports — the largest unit is " +
      "the Port of Paranagua and the largest commodities by weight are ammonium sulphate " +
      "(NCM 31022100) and phosphatic fertilisers (31039090), at US$0.29/kg freight. " +
      "Uncorrected: air weight overstated 4.1x and freight per kg understated by 70% " +
      "(US$3.21 instead of US$10.81).",
    correction: {
      applied: true,
      rule_pt:
        "'Aereo' = CO_VIA=04 E URF de despacho classificada como aeroporto. " +
        "A mesma regra e aplicada a todos os anos comparados.",
      rule_en:
        "'Air' = CO_VIA=04 AND clearance URF classified as airport. " +
        "The same rule is applied to every year being compared.",
    },
    verified:
      "2026-08-26 — medido sobre 919.619 registros de origem China (IMP_2025 + IMP_2026), " +
      "cruzando CO_VIA com CO_URF e conferindo a composicao por NCM.",
    applies: (q) =>
      q.byVia === true ||
      q.freight === true ||
      (q.vias?.some((v) => v === VIA.AEREA) ?? false),
  },

  {
    id: "simplified_regime_absent",
    dataset: "comex-stat/ncm",
    severity: "critical",
    title_pt: "Encomenda internacional NAO existe neste dataset",
    title_en: "International parcels are NOT in this dataset",
    description_pt:
      "Existem codigos de modal para POSTAL (05) e COURIER (11), mas estao praticamente " +
      "vazios. As remessas de baixo valor sao despachadas pelo regime simplificado e nao " +
      "entram nas estatisticas de comercio. Estatistica formal e volume de encomenda sao " +
      "universos disjuntos: nao somar, nao comparar aritmeticamente.",
    description_en:
      "Mode codes exist for POSTAL (05) and COURIER (11) but are effectively empty. " +
      "Low-value shipments clear under the simplified regime and never enter trade " +
      "statistics. Formal trade data and parcel volumes are disjoint universes: never " +
      "add them together or compare them arithmetically.",
    evidence_pt:
      "China -> Brasil, todo 2026 ate julho: POSTAL = 13 registros / 72 kg. " +
      "COURIER = zero registros. No mesmo periodo a imprensa setorial reporta ~180 milhoes " +
      "de encomendas internacionais processadas no Brasil.",
    evidence_en:
      "China -> Brazil, all of 2026 through July: POSTAL = 13 records / 72 kg. " +
      "COURIER = zero records. Over the same period trade press reports ~180 million " +
      "international parcels processed in Brazil.",
    correction: {
      applied: false,
      rule_pt:
        "Nao ha correcao possivel — o dado nao existe na fonte. A unica resposta honesta " +
        "e declarar que a medicao cobre comercio FORMAL e nao captura e-commerce transfronteirico.",
      rule_en:
        "No correction is possible — the data is not in the source. The only honest answer " +
        "is to state that the measurement covers FORMAL trade and does not capture " +
        "cross-border e-commerce.",
    },
    verified:
      "2026-08-26 — contagem direta de registros por CO_VIA sobre IMP_2026 (origem China).",
    applies: (q) =>
      q.parcelIntent === true ||
      q.byVia === true ||
      (q.vias?.some((v) => PARCEL_VIAS.includes(v as 5 | 11)) ?? false),
  },

  {
    id: "declared_not_audited",
    dataset: "comex-stat/ncm",
    severity: "info",
    title_pt: "Frete e seguro sao valores DECLARADOS, nao auditados",
    title_en: "Freight and insurance are DECLARED values, not audited",
    description_pt:
      "VL_FRETE e VL_SEGURO sao o que o importador declarou a aduana. E a melhor medida " +
      "sistematica de custo realizado disponivel publicamente, e e base de calculo " +
      "tributaria — nao fatura auditada. Usar como ordem de magnitude solida, nao como " +
      "custo contratual de um embarque especifico.",
    description_en:
      "VL_FRETE and VL_SEGURO are what the importer declared to customs. They are the best " +
      "systematic measure of realised cost available publicly, and they are a tax base — " +
      "not an audited invoice. Treat as a solid order of magnitude, not as the contract " +
      "cost of a specific shipment.",
    evidence_pt:
      "Consequencia pratica: a base de calculo no Brasil e CIF, logo o frete esta DENTRO " +
      "do valor tributavel. Frete e imposto sao linhas acopladas, nao independentes.",
    evidence_en:
      "Practical consequence: the Brazilian assessment base is CIF, so freight sits INSIDE " +
      "the taxable amount. Freight and duty are coupled lines, not independent ones.",
    verified:
      "2026-08-26 — leitura do layout oficial dos arquivos IMP_*.csv (campos VL_FRETE / VL_SEGURO).",
    applies: (q) => q.freight === true,
  },

  {
    id: "monthly_volatility",
    dataset: "comex-stat/ncm",
    severity: "warning",
    title_pt: "Serie mensal e volatil: janela curta nao estabelece tendencia",
    title_en: "The monthly series is volatile: a short window does not establish a trend",
    description_pt:
      "O grao mensal oscila forte por sazonalidade, embarques pontuais e efeito de " +
      "reclassificacao. Uma alta de varios meses dentro do mesmo ano pode desaparecer na " +
      "comparacao interanual. Sempre conferir o mesmo periodo do ano anterior antes de " +
      "afirmar tendencia.",
    description_en:
      "The monthly grain swings hard on seasonality, one-off shipments and reclassification " +
      "effects. A multi-month rise inside one year can vanish in the year-over-year " +
      "comparison. Always check the same window in the prior year before claiming a trend.",
    evidence_pt:
      "Caso real: o aereo corrigido China->Brasil sobe de 3,91 para 6,33 Mkg entre jan e " +
      "jul/2026 (+62%), o que sugere quebra estrutural. Contra o mesmo periodo de 2025 o " +
      "crescimento e de apenas +6,7%, e 2025 tinha seu proprio pico isolado em maio " +
      "(7,48 Mkg). A 'tendencia' era ruido.",
    evidence_en:
      "Real case: corrected China->Brazil air rises from 3.91 to 6.33 Mkg between Jan and " +
      "Jul 2026 (+62%), which looks like a structural break. Against the same window in " +
      "2025 growth is only +6.7%, and 2025 had its own isolated May peak (7.48 Mkg). " +
      "The 'trend' was noise.",
    correction: {
      applied: false,
      rule_pt: "Comparar a MESMA janela de meses do ano anterior antes de afirmar tendencia.",
      rule_en: "Compare the SAME month window in the prior year before claiming a trend.",
    },
    verified:
      "2026-08-26 — serie mensal corrigida de IMP_2025 e IMP_2026 (origem China), lado a lado.",
    applies: (q) => (q.monthsInResult ?? 0) >= 2 && (q.monthsInResult ?? 0) < 24,
  },
];

/** Caveats que se aplicam a esta consulta, mais severos primeiro. */
export function caveatsFor(q: QueryShape): Caveat[] {
  const rank: Record<Severity, number> = { critical: 0, warning: 1, info: 2 };
  return CAVEATS.filter((c) => c.applies(q)).sort(
    (a, b) => rank[a.severity] - rank[b.severity],
  );
}

export type Lang = "pt" | "en";

/** Forma compacta para anexar na resposta de uma tool. */
export function renderCaveats(q: QueryShape, lang: Lang = "pt") {
  return caveatsFor(q).map((c) => ({
    id: c.id,
    severity: c.severity,
    title: lang === "pt" ? c.title_pt : c.title_en,
    description: lang === "pt" ? c.description_pt : c.description_en,
    evidence: lang === "pt" ? c.evidence_pt : c.evidence_en,
    correction_applied: c.correction?.applied ?? false,
    correction: c.correction
      ? lang === "pt" ? c.correction.rule_pt : c.correction.rule_en
      : null,
    verified: c.verified,
  }));
}
