/**
 * Cliente HTTP para as fontes oficiais.
 *
 * Nao usamos `fetch` aqui por um motivo concreto: precisamos injetar um
 * certificado intermediario (ver src/certs) e a forma suportada de fazer isso
 * no Node e um `https.Agent` com contexto TLS proprio. Fazer isso via fetch
 * dependeria de opcoes nao-publicas do undici.
 *
 * O agente e ESCOPADO a este modulo: nada global e alterado, e a verificacao
 * de certificado continua ligada para todo o resto do processo.
 */

import { Agent, get as httpsGet, request as httpsRequest } from "node:https";
import { rootCertificates } from "node:tls";
import type { IncomingMessage } from "node:http";
import { SECTIGO_OV_R36_PEM } from "./certs/index.js";

/**
 * Raizes padrao do Node MAIS o intermediario que o servidor omite.
 * Passar `ca` SUBSTITUI o bundle padrao — por isso as raizes vao junto,
 * senao qualquer outro host deixaria de validar.
 */
const CA = [...rootCertificates, SECTIGO_OV_R36_PEM];

const agent = new Agent({
  ca: CA,
  keepAlive: true,
  timeout: 120_000,
});

export const USER_AGENT =
  "mcp-comex-brasil/0.1 (+https://github.com/luisdelfin/mcp-comex-brasil)";

/** GET que devolve o stream de resposta, seguindo redirecionamentos. */
export function getStream(url: string, redirects = 3): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    const req = httpsGet(
      url,
      { agent, headers: { "user-agent": USER_AGENT, accept: "*/*" } },
      (res) => {
        const status = res.statusCode ?? 0;
        const loc = res.headers.location;
        if (status >= 300 && status < 400 && loc && redirects > 0) {
          res.resume();
          resolve(getStream(new URL(loc, url).toString(), redirects - 1));
          return;
        }
        if (status !== 200) {
          res.resume();
          reject(new Error(`HTTP ${status} em ${url}`));
          return;
        }
        resolve(res);
      },
    );
    req.on("error", (e) =>
      reject(
        new Error(
          `falha de rede em ${url}: ${e.message}` +
            ((e as NodeJS.ErrnoException).code === "UNABLE_TO_VERIFY_LEAF_SIGNATURE"
              ? " — o certificado intermediario empacotado pode ter vencido; ver src/certs/index.ts"
              : ""),
        ),
      ),
    );
    req.setTimeout(120_000, () => req.destroy(new Error("timeout")));
  });
}

/** Cabecalhos via HEAD — usado para registrar a versao da fonte (Last-Modified). */
export function head(url: string): Promise<Record<string, string | undefined>> {
  return new Promise((resolve) => {
    const req = httpsRequest(
      url,
      { method: "HEAD", agent, headers: { "user-agent": USER_AGENT } },
      (res) => {
        res.resume();
        resolve(res.headers as Record<string, string | undefined>);
      },
    );
    req.on("error", () => resolve({}));
    req.setTimeout(30_000, () => { req.destroy(); resolve({}); });
    req.end();
  });
}

/** Linhas de um CSV remoto, decodificando Latin-1 em streaming. */
export async function* streamLines(
  url: string,
  encoding: BufferEncoding = "latin1",
): AsyncGenerator<string, void, void> {
  const res = await getStream(url);
  const dec = new TextDecoder(encoding);
  let buf = "";
  for await (const chunk of res) {
    buf += dec.decode(chunk as Buffer, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      const clean = line.endsWith("\r") ? line.slice(0, -1) : line;
      if (clean) yield clean;
    }
  }
  buf += dec.decode();
  if (buf.trim()) yield buf.endsWith("\r") ? buf.slice(0, -1) : buf;
}
