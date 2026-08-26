# mcp-comex-brasil

**Servidor MCP de comércio exterior do Brasil — com as armadilhas do dataset corrigidas na resposta.**

Quatro tools que não mentem, em vez de quarenta que não sabem.

---

## O problema que este servidor resolve

Um servidor MCP que apenas *expõe* um dataset entrega ao agente uma API limpa para um número
errado. A encanação não sabe que o campo mente.

O Comex Stat — a base oficial de comércio exterior do Brasil, publicada pela Secretaria de
Comércio Exterior / Receita Federal — tem um defeito que **nenhuma documentação avisa**:

> Filtrar o campo de modal por `AÉREA` retorna 139,6 milhões de kg de importação da China em
> 2026 (jan–jul). Cruzando esses mesmos registros com o **ponto de despacho**, apenas
> 34,0 milhões (24%) passaram por um aeroporto. Os outros 89,7 milhões despacharam em
> **portos marítimos** e são sulfato de amônio e fertilizantes fosfáticos — carga que não voa,
> a US$0,29/kg de frete.
>
> **Sem corrigir: peso aéreo 4,1× inflado e frete por quilo 70% subestimado.** O erro é
> silencioso: nada na consulta acusa.

Este servidor aplica a correção, e devolve junto a evidência de por que ela é necessária.

## As duas garantias

1. **Toda resposta traz os defeitos conhecidos que se aplicam àquela consulta**, com evidência
   medida e procedência da verificação.
2. **A correção crítica está aplicada no resultado, não apenas avisada.** O canal `air` já
   significa "aéreo despachado em aeroporto". O bloco contaminado continua consultável como
   `air_declared_at_port`, de propósito — para quem quiser inspecionar.

## O que o dataset tem que os resumos publicados jogam fora

Os arquivos de **importação** carregam `VL_FRETE` e `VL_SEGURO` — frete e seguro **declarados
à aduana**. É a melhor medida sistemática de custo realizado disponível publicamente, e
praticamente ninguém a usa.

China → Brasil, jan–jul de 2026, já corrigido:

| Canal | Peso (kg) | Frete US$/kg | Frete % do FOB | Densidade de valor |
|---|---|---|---|---|
| Aéreo (aeroporto) | 33.993.130 | **10,81** | 9,37% | US$ 115,36/kg |
| Marítimo | 16.074.641.185 | **0,142** | 5,68% | US$ 2,51/kg |

O aéreo custa **76× mais por quilo** e apenas **1,65× mais por dólar de mercadoria**. O split
modal deste corredor não é uma decisão de frete — é uma decisão de densidade de valor.

## Instalação

Requer **Node ≥ 22.5** (usa o SQLite embutido — zero dependências nativas, nada de `node-gyp`).

```bash
git clone <repo> && cd mcp-comex-brasil
npm install && npm run build
npm run db:build -- --years 2025,2026        # baixa da fonte oficial e monta o SQLite
```

O `db:build` busca os arquivos direto de `balanca.economia.gov.br`. **Nenhum dado é
redistribuído por este pacote** — a base é construída na sua máquina, sempre fresca da fonte.

Opções úteis:

```bash
npm run db:build -- --years 2026 --countries 160        # só China, base pequena e rápida
npm run db:build -- --years 2024,2025,2026 --flows import,export
```

### Configuração no cliente MCP

```json
{
  "mcpServers": {
    "comex": {
      "command": "node",
      "args": ["--experimental-sqlite", "/caminho/para/mcp-comex-brasil/dist/index.js"],
      "env": { "COMEX_LANG": "pt" }
    }
  }
}
```

`COMEX_LANG` aceita `pt` (default) ou `en`. `COMEX_DB` sobrescreve o caminho do banco.

## As quatro tools

| Tool | O que faz |
|---|---|
| `comex_trade_flow` | Valor, peso e densidade de valor por ano, mês, país, NCM e canal. O canal `air` já vem corrigido. |
| `comex_freight_cost` | Frete e seguro declarados por canal: US$/kg e % do FOB. Só importação. |
| `comex_data_caveats` | Os defeitos conhecidos do dataset, com evidência, regra de correção e checklist de conferência. |
| `comex_resolve_code` | Resolve país, NCM, modal e URF de despacho (com a classificação aeroporto/porto/outra). |

## Os caveats que acompanham as respostas

| id | Severidade | Corrigido? |
|---|---|---|
| `via_contamination` | crítico | ✅ automático (cruzamento com o ponto de despacho) |
| `simplified_regime_absent` | crítico | ❌ impossível — o dado não existe na fonte |
| `declared_not_audited` | info | — |
| `monthly_volatility` | aviso | ❌ exige comparação interanual |

Sobre `simplified_regime_absent`: existem códigos de modal para POSTAL e COURIER, mas estão
vazios (13 registros e 72 kg para a China em todo 2026, contra ~180 milhões de encomendas
internacionais reportadas). As remessas de baixo valor passam pelo regime simplificado e não
entram nas estatísticas de comércio. **Estatística formal e volume de encomenda são universos
disjuntos** — não somar, não comparar aritmeticamente.

## Verificação

Os agregados foram validados por **implementação cruzada**: o mesmo recorte processado por uma
passada de `awk` sobre o CSV cru e pela view SQL deste servidor produz números idênticos até o
último dígito (349.250 registros, 7 canais, valores de frete e peso).

```bash
npm test     # 12 testes da lógica de classificação e do registro de caveats
```

## Licença e fonte

MIT. Dados: Comex Stat, Secretaria de Comércio Exterior / Receita Federal do Brasil
(`balanca.economia.gov.br`) — fonte pública, consultada em tempo de construção da base.

Autor: **Luis Delfin**

---
---

# English

**MCP server for Brazilian foreign-trade data — with the dataset's traps corrected in the response.**

Four tools that don't lie, instead of forty that don't know.

## The problem

An MCP server that merely *exposes* a dataset hands the agent a clean API to a wrong number.
The plumbing doesn't know the field lies.

Brazil's official trade dataset (Comex Stat, published by the Foreign Trade Secretariat /
Federal Revenue Service) has a defect **no documentation warns about**:

> Filtering the transport-mode field by `AIR` returns 139.6 million kg of Chinese imports for
> Jan–Jul 2026. Cross-referencing those same records against their **clearance point**, only
> 34.0 million (24%) passed through an airport. The other 89.7 million cleared at **seaports**
> and consist of ammonium sulphate and phosphatic fertilisers — cargo that does not fly, at
> US$0.29/kg freight.
>
> **Uncorrected: air weight overstated 4.1× and freight per kg understated by 70%.** The error
> is silent — nothing in the query flags it.

This server applies the correction, and returns the evidence for why it is needed.

## Two guarantees

1. **Every response carries the known defects that apply to that query**, with measured
   evidence and verification provenance.
2. **The critical correction is applied, not merely warned about.** The `air` channel already
   means "air mode cleared at an airport". The contaminated block stays queryable as
   `air_declared_at_port`, deliberately — for anyone who wants to inspect it.

## What the dataset has that published summaries discard

The **import** files carry `VL_FRETE` and `VL_SEGURO` — freight and insurance **as declared to
customs**. It is the best systematic measure of realised cost available publicly, and almost
nobody uses it.

China → Brazil, Jan–Jul 2026, corrected:

| Channel | Weight (kg) | Freight US$/kg | Freight % of FOB | Value density |
|---|---|---|---|---|
| Air (airport-cleared) | 33,993,130 | **10.81** | 9.37% | US$115.36/kg |
| Sea | 16,074,641,185 | **0.142** | 5.68% | US$2.51/kg |

Air costs **76× more per kilogram** and only **1.65× more per dollar of goods**. This
corridor's modal split is not a freight decision — it is a value-density decision.

## Install

Requires **Node ≥ 22.5** (uses built-in SQLite — zero native dependencies, no `node-gyp`).

```bash
npm install && npm run build
npm run db:build -- --years 2025,2026        # fetches from the official source, builds SQLite
```

`db:build` pulls the files straight from `balanca.economia.gov.br`. **No data is redistributed
by this package** — the database is built on your machine, always fresh from the source.

## The four tools

| Tool | What it does |
|---|---|
| `comex_trade_flow` | Value, weight and value density by year, month, country, HS code and channel. `air` is pre-corrected. |
| `comex_freight_cost` | Declared freight and insurance per channel: US$/kg and % of FOB. Imports only. |
| `comex_data_caveats` | The dataset's known defects, with evidence, correction rule and a pre-publication checklist. |
| `comex_resolve_code` | Resolves country, HS code, transport mode and clearance unit (with airport/seaport classification). |

## Verification

Aggregates were validated by **cross-implementation**: the same slice processed by a single
`awk` pass over the raw CSV and by this server's SQL view produces identical figures to the
last digit (349,250 records, 7 channels, freight and weight values).

```bash
npm test     # 12 tests covering the classification logic and the caveat registry
```

MIT. Data: Comex Stat, Brazilian Foreign Trade Secretariat / Federal Revenue Service.
Author: **Luis Delfin**
