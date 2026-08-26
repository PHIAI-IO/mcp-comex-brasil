#!/usr/bin/env node
/**
 * mcp-comex-brasil — servidor MCP de comercio exterior do Brasil.
 *
 * Nao e mais um wrapper de dataset. A diferenca esta em duas garantias:
 *
 *   1. Toda resposta traz os DEFEITOS CONHECIDOS que se aplicam aquela consulta,
 *      com evidencia medida — porque um wrapper que so expoe o dado entrega ao
 *      agente uma API limpa para um numero errado.
 *   2. A correcao do modal de transporte (o defeito critico deste dataset) esta
 *      APLICADA no resultado, nao apenas avisada.
 *
 * Quatro tools que nao mentem, em vez de quarenta que nao sabem.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { DbMissingError } from "./db.js";
import { tradeFlow, freightCost, dataCaveats, resolveCode } from "./tools/index.js";
import type { Lang } from "./caveats.js";

const LANG: Lang = (process.env.COMEX_LANG === "en" ? "en" : "pt") as Lang;

const TOOLS = [
  {
    name: "comex_trade_flow",
    description:
      "Fluxo de comercio exterior do Brasil (valor, peso e densidade de valor) a partir dos " +
      "microdados aduaneiros oficiais do Comex Stat. Filtra por ano, mes, pais, NCM e canal " +
      "de transporte, e agrupa como pedido. O canal 'air' JA vem corrigido pelo ponto de " +
      "despacho — o campo de modal do dataset e contaminado e nao pode ser usado cru. " +
      "A resposta inclui sempre os caveats aplicaveis e a procedencia dos arquivos.",
    inputSchema: {
      type: "object",
      properties: {
        flow: { type: "string", enum: ["import", "export"], description: "Sentido do fluxo. Default: import." },
        years: { type: "array", items: { type: "integer" }, description: "Anos, ex: [2025, 2026]." },
        months: { type: "array", items: { type: "integer" }, description: "Meses 1-12. Vazio = todos." },
        countries: {
          type: "array", items: { type: "string" },
          description: "Codigo, nome (PT/EN) ou ISO3. Ex: ['160'] ou ['China'].",
        },
        ncm: { type: "string", description: "NCM completo (8 digitos) ou prefixo, ex: '8517' ou '85'." },
        channel: {
          type: "string",
          enum: ["all", "air", "sea", "parcel", "road", "air_declared_at_port", "air_declared_inland", "other"],
          description:
            "Canal corrigido. 'air' = modal aereo despachado em aeroporto. " +
            "'air_declared_at_port' expoe o bloco contaminado, para inspecao.",
        },
        group_by: {
          type: "array",
          items: { type: "string", enum: ["year", "month", "channel", "country", "ncm", "urf", "uf", "urf_kind"] },
          description: "Dimensoes de agrupamento. Default: ['year'].",
        },
        limit: { type: "integer", description: "Maximo de linhas (default 50, max 500)." },
      },
    },
  },
  {
    name: "comex_freight_cost",
    description:
      "Frete e seguro DECLARADOS a aduana, por canal de transporte — em US$/kg e como % do " +
      "valor FOB. Vem dos campos VL_FRETE e VL_SEGURO dos arquivos de importacao, que os " +
      "resumos publicados descartam: e a melhor medida sistematica de custo realizado " +
      "disponivel publicamente. Somente importacao (os arquivos de exportacao nao trazem " +
      "frete). O canal 'air' ja esta corrigido pelo ponto de despacho.",
    inputSchema: {
      type: "object",
      properties: {
        years: { type: "array", items: { type: "integer" }, description: "Anos, ex: [2025, 2026]." },
        months: { type: "array", items: { type: "integer" }, description: "Meses 1-12. Vazio = todos." },
        countries: { type: "array", items: { type: "string" }, description: "Codigo, nome ou ISO3 do pais de origem." },
        ncm: { type: "string", description: "NCM completo ou prefixo." },
        group_by: {
          type: "array",
          items: { type: "string", enum: ["year", "month", "country", "ncm", "urf", "urf_kind"] },
          description: "Dimensoes extra (o canal ja entra sempre).",
        },
      },
    },
  },
  {
    name: "comex_data_caveats",
    description:
      "Defeitos conhecidos do dataset do Comex Stat, cada um com evidencia quantificada, " +
      "regra de correcao e procedencia da verificacao. Use ANTES de publicar qualquer numero " +
      "derivado desta fonte — inclui o checklist de conferencia. Esta tool responde a " +
      "pergunta que um wrapper de dados nunca responde: este campo quer dizer o que parece?",
    inputSchema: {
      type: "object",
      properties: {
        id: {
          type: "string",
          enum: ["via_contamination", "simplified_regime_absent", "declared_not_audited", "monthly_volatility"],
          description: "Um caveat especifico. Vazio = todos.",
        },
      },
    },
  },
  {
    name: "comex_resolve_code",
    description:
      "Resolve codigos oficiais para nomes e vice-versa: pais, NCM, modal de transporte (VIA) " +
      "e unidade da Receita de despacho (URF, com sua classificacao aeroporto/porto/outra). " +
      "Necessario porque o dataset e todo codificado.",
    inputSchema: {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["country", "ncm", "via", "urf"], description: "Tipo de codigo." },
        query: { type: "string", description: "Codigo exato ou parte do nome." },
        limit: { type: "integer", description: "Maximo de resultados (default 20)." },
      },
      required: ["kind", "query"],
    },
  },
] as const;

const server = new Server(
  { name: "mcp-comex-brasil", version: "0.1.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: rawArgs } = request.params;
  const args = (rawArgs ?? {}) as Record<string, unknown>;

  try {
    let result: unknown;
    switch (name) {
      case "comex_trade_flow":    result = tradeFlow(args, LANG); break;
      case "comex_freight_cost":  result = freightCost(args, LANG); break;
      case "comex_data_caveats":  result = dataCaveats(args, LANG); break;
      case "comex_resolve_code":  result = resolveCode(args); break;
      default:
        return {
          content: [{ type: "text", text: `Tool desconhecida: ${name}` }],
          isError: true,
        };
    }
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  } catch (e) {
    // O erro mais provavel na primeira execucao e o banco nao construido —
    // a mensagem tem que dizer exatamente o comando que resolve.
    const msg = e instanceof DbMissingError
      ? e.message
      : `Erro em ${name}: ${e instanceof Error ? e.message : String(e)}`;
    return { content: [{ type: "text", text: msg }], isError: true };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
process.stderr.write("mcp-comex-brasil pronto (stdio)\n");
