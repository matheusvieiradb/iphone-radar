// Robô de coleta de preços do iPhone 17 (roda no GitHub Actions, sem nenhuma IA envolvida).
//
// Fontes automáticas confiáveis (públicas, sem login, sem burlar nenhuma proteção anti-robô):
//   - Mercado Livre: API pública de busca (api.mercadolibre.com)
//   - OLX: página de busca renderizada no servidor (HTML já vem com preço e título prontos)
//   - KaBuM: JSON estruturado (__NEXT_DATA__) embutido na própria página de busca
//
// Fontes "melhor esforço" (funcionam hoje, mas têm detecção anti-robô ativa e/ou termos de
// uso que proíbem coleta automatizada — se bloquearem, o robô só ignora essa fonte nesta
// rodada, sem NUNCA tentar contornar o bloqueio: sem resolver captcha, sem trocar de IP,
// sem fingir ser outro tipo de cliente):
//   - Amazon BR: tem detecção Akamai; um pedido isolado por rodada costuma passar.
//   - Google Shopping: agrega várias lojas de uma vez, mas o HTML é ofuscado de propósito
//     e pode quebrar com qualquer mudança no layout do Google.
//
// Fonte descartada (bloqueia de forma consistente, sem alternativa sem burlar proteção):
//   - Magazine Luiza: responde 403 (bloqueio direto) mesmo na 1ª tentativa, em qualquer sessão.
//
// Preço oficial da Apple Store BR é mantido manualmente em data/prices.json (campo
// "officialAppleBRL" de cada combinação, raramente muda) — este script nunca o sobrescreve.

import { readFile, writeFile } from "node:fs/promises";

const DATA_PATH = new URL("../data/prices.json", import.meta.url);
const MAX_HISTORY = 120; // ~2 meses com 4 rodadas/dia
const UA = "iphone-radar-personal-tracker/1.0 (uso pessoal, baixa frequência)";

const COMBOS = [
  { id: "base-256", variant: "base", storageGB: 256, query: "iphone 17 256gb" },
  { id: "base-512", variant: "base", storageGB: 512, query: "iphone 17 512gb" },
  { id: "air-256", variant: "Air", storageGB: 256, query: "iphone 17 air 256gb" },
  { id: "air-512", variant: "Air", storageGB: 512, query: "iphone 17 air 512gb" },
  { id: "air-1024", variant: "Air", storageGB: 1024, query: "iphone 17 air 1tb" },
  { id: "pro-256", variant: "Pro", storageGB: 256, query: "iphone 17 pro 256gb" },
  { id: "pro-512", variant: "Pro", storageGB: 512, query: "iphone 17 pro 512gb" },
  { id: "pro-1024", variant: "Pro", storageGB: 1024, query: "iphone 17 pro 1tb" },
  { id: "pro-max-256", variant: "Pro Max", storageGB: 256, query: "iphone 17 pro max 256gb" },
  { id: "pro-max-512", variant: "Pro Max", storageGB: 512, query: "iphone 17 pro max 512gb" },
  { id: "pro-max-1024", variant: "Pro Max", storageGB: 1024, query: "iphone 17 pro max 1tb" },
  { id: "pro-max-2048", variant: "Pro Max", storageGB: 2048, query: "iphone 17 pro max 2tb" },
];

function isIphone17(textLower) {
  // Exige "iphone" + "17" no texto — descarta iPad, iPhone 12/13/14/15/16 e acessórios
  // que às vezes aparecem misturados em resultados de busca de terceiros.
  return textLower.includes("iphone") && /\b17\b/.test(textLower) && !textLower.includes("ipad");
}

function matchesVariant(textLower, variant) {
  const hasPro = textLower.includes("pro");
  const hasMax = textLower.includes("max");
  const hasAir = textLower.includes("air");
  if (variant === "base") return !hasPro && !hasAir;
  if (variant === "Air") return hasAir;
  if (variant === "Pro") return hasPro && !hasMax;
  if (variant === "Pro Max") return hasPro && hasMax;
  return false;
}

function matchesStorage(textLower, storageGB) {
  const gbForm = storageGB >= 1024 ? null : `${storageGB}gb`;
  const tbForm = storageGB >= 1024 ? `${storageGB / 1024}tb` : null;
  if (gbForm && textLower.includes(gbForm)) return true;
  if (tbForm && (textLower.includes(tbForm) || textLower.includes(tbForm.replace("tb", " tb")))) return true;
  return false;
}

function parseBRL(str) {
  const n = parseFloat(String(str).replace(/\./g, "").replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

function average(nums) {
  if (nums.length === 0) return null;
  const sum = nums.reduce((a, b) => a + b, 0);
  return Math.round(sum / nums.length);
}

function nowInBrasilia() {
  // Brasília não usa horário de verão desde 2019: UTC-03:00 o ano todo.
  const now = new Date();
  const utcMs = now.getTime() + now.getTimezoneOffset() * 60000;
  const brasilia = new Date(utcMs - 3 * 60 * 60000);
  const pad = (n) => String(n).padStart(2, "0");
  return (
    `${brasilia.getFullYear()}-${pad(brasilia.getMonth() + 1)}-${pad(brasilia.getDate())}` +
    `T${pad(brasilia.getHours())}:${pad(brasilia.getMinutes())}:${pad(brasilia.getSeconds())}-03:00`
  );
}

// ---------- Mercado Livre (API pública) ----------
async function searchMercadoLivre(combo) {
  const url = `https://api.mercadolibre.com/sites/MLB/search?q=${encodeURIComponent(combo.query)}&limit=50`;
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`Mercado Livre respondeu ${res.status}`);
  const body = await res.json();
  const results = Array.isArray(body.results) ? body.results : [];
  const out = { new: [], used: [] };
  for (const item of results) {
    const title = String(item.title || "").toLowerCase();
    if (!isIphone17(title)) continue;
    if (!matchesVariant(title, combo.variant)) continue;
    if (!matchesStorage(title, combo.storageGB)) continue;
    if (typeof item.price !== "number") continue;
    (item.condition === "used" ? out.used : out.new).push(item.price);
  }
  return out;
}

// ---------- OLX (HTML renderizado no servidor, sem API separada) ----------
async function searchOLX(combo) {
  const url = `https://www.olx.com.br/brasil?q=${encodeURIComponent(combo.query)}`;
  const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "text/html" } });
  if (!res.ok) throw new Error(`OLX respondeu ${res.status}`);
  const html = await res.text();
  const out = { new: [], used: [] };
  const cardRe = /title="([^"]+)"[^]*?olx-adcard__price[^>]*>R\$\s?([\d.,]+)<\/h3>/g;
  let m;
  while ((m = cardRe.exec(html))) {
    const title = m[1].toLowerCase();
    const price = parseBRL(m[2]);
    if (price === null) continue;
    if (!isIphone17(title)) continue;
    if (!matchesVariant(title, combo.variant)) continue;
    if (!matchesStorage(title, combo.storageGB)) continue;
    const isNew = /\b(novo|lacrado|selado|zero km)\b/.test(title);
    (isNew ? out.new : out.used).push(price);
  }
  return out;
}

// ---------- KaBuM (JSON __NEXT_DATA__ embutido na página de busca) ----------
async function searchKabum(combo) {
  const slug = combo.query.trim().replace(/\s+/g, "-");
  const url = `https://www.kabum.com.br/busca/${encodeURIComponent(slug)}`;
  const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "text/html" } });
  if (!res.ok) throw new Error(`KaBuM respondeu ${res.status}`);
  const html = await res.text();
  const marker = "__NEXT_DATA__";
  const start = html.indexOf(marker);
  if (start === -1) throw new Error("KaBuM: __NEXT_DATA__ não encontrado (site pode ter mudado)");
  const scriptStart = html.indexOf(">", start) + 1;
  const scriptEnd = html.indexOf("</script>", scriptStart);
  const json = JSON.parse(html.slice(scriptStart, scriptEnd));

  function findProductArray(obj) {
    if (Array.isArray(obj) && obj.length && obj[0] && typeof obj[0] === "object" && "friendlyName" in obj[0]) {
      return obj;
    }
    if (obj && typeof obj === "object") {
      for (const k in obj) {
        const found = findProductArray(obj[k]);
        if (found) return found;
      }
    }
    return null;
  }
  const products = findProductArray(json) || [];

  const out = { new: [], used: [] };
  for (const p of products) {
    const name = String(p.name || p.friendlyName || "").toLowerCase();
    if (!isIphone17(name)) continue;
    if (!matchesVariant(name, combo.variant)) continue;
    if (!matchesStorage(name, combo.storageGB)) continue;
    const price = typeof p.priceWithDiscount === "number" && p.priceWithDiscount > 0 ? p.priceWithDiscount : p.price;
    if (typeof price !== "number") continue;
    (name.includes("usado") ? out.used : out.new).push(price);
  }
  return out;
}

// ---------- Amazon BR (best-effort: a Amazon tem detecção anti-robô ativa e proíbe
// coleta automatizada nos termos de uso; se ela bloquear, apenas ignoramos esta fonte
// nesta rodada — não tentamos contornar o bloqueio de forma alguma). ----------
async function searchAmazon(combo) {
  const url = `https://www.amazon.com.br/s?k=${encodeURIComponent(combo.query)}`;
  const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "text/html" } });
  if (!res.ok) throw new Error(`Amazon respondeu ${res.status}`);
  const html = await res.text();
  if (html.includes("bm-verify") || html.length < 5000) {
    throw new Error("Amazon apresentou desafio anti-robô nesta rodada — ignorando (sem tentar contornar)");
  }
  const out = { new: [], used: [] };
  const marker = 'data-component-type="s-search-result"';
  const parts = html.split(marker).slice(1);
  for (const part of parts) {
    const end = part.indexOf(marker);
    const scope = end > 0 ? part.slice(0, end) : part.slice(0, 20000);
    const titleM = scope.match(/<h2[^>]*>[\s\S]*?<span[^>]*>([^<]+)<\/span>/);
    const priceM = scope.match(/a-offscreen">R\$\s?([\d.,]+)<\/span>/);
    if (!titleM || !priceM) continue;
    const title = titleM[1].toLowerCase();
    const price = parseBRL(priceM[1]);
    if (price === null) continue;
    if (!isIphone17(title)) continue;
    if (!matchesVariant(title, combo.variant)) continue;
    if (!matchesStorage(title, combo.storageGB)) continue;
    const isNew = !/\b(usado|recondicionado|seminovo|renewed)\b/.test(title);
    (isNew ? out.new : out.used).push(price);
  }
  return out;
}

// ---------- Google Shopping (best-effort: HTML propositalmente ofuscado pelo Google
// e termos de uso proíbem automação — usamos aqui como agregador multi-loja, mas o
// parser pode quebrar com qualquer mudança e podemos ser bloqueados sem aviso). ----------
async function searchGoogleShopping(combo) {
  const url = `https://www.google.com/search?q=${encodeURIComponent(combo.query)}&tbm=shop&hl=pt-BR&gl=BR`;
  const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "text/html" } });
  if (!res.ok) throw new Error(`Google Shopping respondeu ${res.status}`);
  const html = await res.text();
  const out = { new: [], used: [] };
  const cardRe = /role="heading"[^]*?<div>([^<]+)<\/div>[^]*?R\$\s?([\d.,]+)<\/span>[^]*?aria-label="De ([^"]+)"/g;
  let m;
  while ((m = cardRe.exec(html))) {
    const title = m[1].toLowerCase();
    const price = parseBRL(m[2]);
    if (price === null) continue;
    if (!isIphone17(title)) continue;
    if (!matchesVariant(title, combo.variant)) continue;
    if (!matchesStorage(title, combo.storageGB)) continue;
    const isNew = !/\b(usado|recondicionado|seminovo)\b/.test(title);
    (isNew ? out.new : out.used).push(price);
  }
  return out;
}

const SOURCES = [
  { name: "Mercado Livre", fetcher: searchMercadoLivre },
  { name: "OLX", fetcher: searchOLX },
  { name: "KaBuM", fetcher: searchKabum },
  { name: "Amazon BR", fetcher: searchAmazon },
  { name: "Google Shopping", fetcher: searchGoogleShopping },
];

async function updateCombo(existing, combo) {
  const prevNew = existing?.new || { bySite: {} };
  const prevUsed = existing?.used || { bySite: {} };
  const officialAppleBRL = existing?.officialAppleBRL ?? null;

  const newBySite = { ...prevNew.bySite };
  const usedBySite = { ...prevUsed.bySite };
  let anyFreshData = false;

  for (const source of SOURCES) {
    try {
      const { new: newPrices = [], used: usedPrices = [] } = await source.fetcher(combo);
      if (newPrices.length) {
        newBySite[source.name] = average(newPrices.sort((a, b) => a - b).slice(0, 5));
        anyFreshData = true;
      }
      if (usedPrices.length) {
        usedBySite[source.name] = average(usedPrices.sort((a, b) => a - b).slice(0, 5));
        anyFreshData = true;
      }
    } catch (err) {
      console.error(`[${combo.id}] Falha em ${source.name}:`, err.message);
    }
  }
  if (officialAppleBRL !== null) newBySite["Apple Store BR"] = officialAppleBRL;

  const newVals = Object.values(newBySite).filter((v) => typeof v === "number");
  const usedVals = Object.values(usedBySite).filter((v) => typeof v === "number");

  const newAvg = newVals.length ? average(newVals) : (prevNew.avgBRL ?? null);
  const usedAvg = usedVals.length ? average(usedVals) : (prevUsed.avgBRL ?? null);

  const ts = nowInBrasilia();
  const history = Array.isArray(existing?.history) ? existing.history.slice() : [];
  history.push({ ts, avgNew: newAvg, avgUsed: usedAvg });
  while (history.length > MAX_HISTORY) history.shift();

  return {
    variant: combo.variant,
    storageGB: combo.storageGB,
    officialAppleBRL,
    new: { avgBRL: newAvg, estimated: !anyFreshData, bySite: newBySite },
    used: { avgBRL: usedAvg, estimated: !anyFreshData, bySite: usedBySite },
    history,
  };
}

async function main() {
  const raw = await readFile(DATA_PATH, "utf-8");
  const data = JSON.parse(raw);
  data.combos = data.combos || {};

  for (const combo of COMBOS) {
    console.log(`Atualizando ${combo.id}...`);
    data.combos[combo.id] = await updateCombo(data.combos[combo.id], combo);
    // pequena pausa entre combinações para não martelar os sites em sequência
    await new Promise((r) => setTimeout(r, 1500));
  }

  data.generatedAt = nowInBrasilia();
  data.nextRuns = ["06:00", "12:00", "17:00", "22:00"];
  data.schedule = "Diariamente às 06h, 12h, 17h e 22h (horário de Brasília)";
  data.lastRunType = "automática (GitHub Actions, sem IA)";
  data.sources = ["Mercado Livre", "OLX", "KaBuM", "Amazon BR (melhor esforço)", "Google Shopping (melhor esforço)", "Apple Store BR (manual)"];

  await writeFile(DATA_PATH, JSON.stringify(data, null, 2) + "\n", "utf-8");
  console.log("data/prices.json atualizado.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
