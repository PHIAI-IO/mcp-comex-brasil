/**
 * Testes da logica que sustenta a correcao.
 *
 * Foco deliberado: `classifyUrf` e o registro de caveats. Se `classifyUrf` errar,
 * TODO numero de frete aereo sai errado — e o erro e silencioso. Por isso os
 * casos aqui incluem os registros reais que expuseram a contaminacao.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { classifyUrf, cleanUrfName, VIA, PARCEL_VIAS } from "./sources.js";
import { caveatsFor, CAVEATS } from "./caveats.js";

describe("classifyUrf", () => {
  test("reconhece aeroportos pelo nome oficial", () => {
    for (const n of [
      "0817700 - AEROPORTO INTERNACIONAL DE VIRACOPOS",
      "0817600 - AEROPORTO INTERNACIONAL DE SAO PAULO/GUARULHOS",
      "0227700 - AEROPORTO EDUARDO GOMES",
      "IRF - AEROPORTO INTERNACIONAL DE FLORIANOPOLIS",
    ]) assert.equal(classifyUrf(n), "airport", n);
  });

  test("reconhece os portos que produziram a contaminacao", () => {
    // Paranagua concentrava 49% do peso declarado como 'aereo' em 2026.
    for (const n of [
      "0917800 - PORTO DE PARANAGUA",
      "0927800 - ITAJAI",
      "0727600 - PORTO DE VITORIA",
    ]) assert.equal(classifyUrf(n), "seaport", n);
  });

  test("nao chuta: o que nao reconhece fica 'other'", () => {
    assert.equal(classifyUrf("0917900 - ALF - CURITIBA"), "other");
    assert.equal(classifyUrf("9999999 - UNIDADE INEXISTENTE"), "other");
  });

  test("um aeroporto nunca e classificado como porto", () => {
    // 'AEROPORTO' e testado primeiro de proposito: nomes como
    // 'AEROPORTO DE PORTO ALEGRE' contem 'PORTO' e cairiam na lista de portos.
    assert.equal(classifyUrf("0000000 - AEROPORTO INTERNACIONAL DE PORTO ALEGRE"), "airport");
  });

  test("cleanUrfName remove o prefixo numerico", () => {
    assert.equal(cleanUrfName("0817700 - AEROPORTO INTERNACIONAL DE VIRACOPOS"),
      "AEROPORTO INTERNACIONAL DE VIRACOPOS");
  });
});

describe("registro de caveats", () => {
  test("consultar frete dispara a contaminacao do modal", () => {
    const ids = caveatsFor({ flow: "import", freight: true }).map((c) => c.id);
    assert.ok(ids.includes("via_contamination"));
    assert.ok(ids.includes("declared_not_audited"));
  });

  test("filtrar por modal aereo dispara a contaminacao", () => {
    const ids = caveatsFor({ flow: "import", vias: [VIA.AEREA] }).map((c) => c.id);
    assert.ok(ids.includes("via_contamination"));
  });

  test("tocar POSTAL/COURIER dispara o aviso de regime simplificado", () => {
    for (const v of PARCEL_VIAS) {
      const ids = caveatsFor({ flow: "import", vias: [v] }).map((c) => c.id);
      assert.ok(ids.includes("simplified_regime_absent"), `via ${v}`);
    }
  });

  test("serie mensal curta dispara o aviso de volatilidade", () => {
    assert.ok(caveatsFor({ flow: "import", monthsInResult: 7 }).some((c) => c.id === "monthly_volatility"));
    // Serie longa nao precisa do aviso.
    assert.ok(!caveatsFor({ flow: "import", monthsInResult: 36 }).some((c) => c.id === "monthly_volatility"));
    // Um unico mes nao e serie.
    assert.ok(!caveatsFor({ flow: "import", monthsInResult: 1 }).some((c) => c.id === "monthly_volatility"));
  });

  test("consulta trivial nao dispara caveats criticos", () => {
    const sev = caveatsFor({ flow: "import" }).map((c) => c.severity);
    assert.ok(!sev.includes("critical"));
  });

  test("ordena por severidade: critical antes de warning e info", () => {
    const got = caveatsFor({ flow: "import", freight: true, byVia: true, monthsInResult: 7 })
      .map((c) => c.severity);
    const rank = { critical: 0, warning: 1, info: 2 } as const;
    for (let i = 1; i < got.length; i++) {
      assert.ok(rank[got[i - 1]!] <= rank[got[i]!], `ordem quebrada em ${i}: ${got.join(",")}`);
    }
  });

  test("todo caveat declara procedencia e evidencia — sem isto nao e verificavel", () => {
    for (const c of CAVEATS) {
      assert.ok(c.verified.length > 20, `${c.id} sem procedencia`);
      assert.ok(c.evidence_pt.length > 40, `${c.id} sem evidencia PT`);
      assert.ok(c.evidence_en.length > 40, `${c.id} sem evidencia EN`);
      assert.ok(c.title_pt && c.title_en, `${c.id} sem titulo bilingue`);
    }
  });
});
