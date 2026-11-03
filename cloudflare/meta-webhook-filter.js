// Cloudflare Worker — filtro do webhook da Meta (WhatsApp) na frente do n8n.
// Atende dois números (roteia pelo phone_number_id):
//
// Sofist Laser e Taynara Fagundes (mesmo webhook do CTWA no n8n)
// - Status (enviado/entregue/lido): responde OK e não repassa.
// - Mensagem de cliente: responde OK pra Meta NA HORA (evita o reenvio que a
//   Meta faz quando a resposta passa de ~20s) e entrega ao n8n em segundo plano.
//   Se o n8n recusar/cair logo de cara, tenta de novo algumas vezes.
// - Agrupamento (igual ao da Star Motors, abaixo): a mensagem é gravada na
//   tabela whatsapp_buffer e o Worker espera AGRUPAR_MS sem mensagem nova do
//   mesmo telefone antes de mandar pro n8n — textos seguidos viram um só envio.
//
// Star Motors
// - TODA mensagem de cliente (texto, foto, áudio, botão) é gravada direto no
//   Supabase (tabela star_motors_mensagens).
// - O toque nos botões da campanha ("Quero saber mais" / "Não tenho
//   interesse", ou sair/parar...) segue pro n8n de respostas, que marca a planilha.
// - Agrupamento pro Aquecimento: o cliente costuma mandar várias mensagens em
//   sequência ("oi", "tudo bem?", "qual o valor?"). O Worker espera
//   AGRUPAR_MS sem mensagem nova daquele telefone e manda os textos juntos numa
//   única mensagem pro n8n — uma execução e uma resposta da IA em vez de várias.
//   Só textos seguidos são juntados; foto, áudio, botão e o resto seguem um por
//   um e sem alteração, na ordem em que chegaram (o n8n analisa/transcreve cada mídia).
//   A marcação enviado_ao_n8n=true no Supabase indica o que já foi pro n8n.
//
// Variáveis do Worker (Settings > Variables and Secrets):
// - SUPABASE_KEY (secret): service_role key do projeto Supabase.
// - VERIFY_TOKEN (opcional): token de verificação do webhook na Meta.

const N8N_SOFIST = "https://vmais.app.n8n.cloud/webhook/ctwa-taynara-sofist";
const N8N_STAR_MOTORS = "https://vmais.app.n8n.cloud/webhook/star-motors-respostas";
const N8N_STAR_AQUECIMENTO = "https://vmais.app.n8n.cloud/webhook/star-aquecimento";
const SUPABASE_URL = "https://tishvpoxekxocyzdiaja.supabase.co";

const PHONE_STAR_MOTORS = "1170154492850086";
const VERIFY_TOKEN_PADRAO = "6ce7d877e49cbfdbfec65de6eafc3ee4e6e4d3861d0df402";

const HEADERS_REPASSADOS = ["content-type", "x-hub-signature", "x-hub-signature-256", "user-agent"];
const TENTATIVAS = 3;
const ESPERA_MS = 4000;
const FALHA_RAPIDA_MS = 8000; // erro antes disso = n8n não processou, pode tentar de novo
// Cloudflare encerra o waitUntil ~30s depois da resposta; 20s cobre a maior
// parte das rajadas (dado de out/26: 436 de 1.391 mensagens vieram <20s da anterior).
const AGRUPAR_MS = 20000;
const JANELA_PENDENTES_MS = 10 * 60 * 1000; // só agrupa mensagens recentes ainda não enviadas

function montarHeaders(req) {
  const h = new Headers({ "Content-Type": "application/json" });
  for (const nome of HEADERS_REPASSADOS) {
    const v = req.headers.get(nome);
    if (v) h.set(nome, v);
  }
  return h;
}

async function entregarAoN8n(url, body, headers) {
  for (let i = 1; i <= TENTATIVAS; i++) {
    const inicio = Date.now();
    try {
      const r = await fetch(url, { method: "POST", headers, body });
      if (!r.ok) console.log(`n8n respondeu ${r.status} em ${url}`);
      if (r.status < 500) return r.ok;
      console.log(`n8n respondeu ${r.status} (tentativa ${i})`);
    } catch (e) {
      console.log(`n8n inalcançável (tentativa ${i}): ${e}`);
    }
    // Erro depois de muito tempo = o n8n já estava processando; não duplica.
    if (Date.now() - inicio > FALHA_RAPIDA_MS) return false;
    if (i < TENTATIVAS) await new Promise((ok) => setTimeout(ok, ESPERA_MS));
  }
  return false;
}

// Uma "mensagem" = payload com uma única change que tem messages[].
function mensagensDoPayload(payload) {
  const lista = [];
  for (const entry of payload?.entry || []) {
    for (const change of entry?.changes || []) {
      const msgs = change?.value?.messages;
      if (change?.field === "messages" && Array.isArray(msgs) && msgs.length > 0) {
        lista.push({ ...payload, entry: [{ ...entry, changes: [change] }] });
      }
    }
  }
  return lista;
}

function phoneIdDe(m) {
  return m.entry[0].changes[0].value?.metadata?.phone_number_id || "";
}

// ---------- Leitura das mensagens ----------

function textoDaMensagem(msg) {
  switch (msg.type) {
    case "text": return msg.text?.body || "";
    case "button": return msg.button?.text || msg.button?.payload || "";
    case "interactive":
      return msg.interactive?.button_reply?.title || msg.interactive?.list_reply?.title || "";
    case "image": return msg.image?.caption || "[foto]";
    case "video": return msg.video?.caption || "[vídeo]";
    case "document": return msg.document?.caption || msg.document?.filename || "[documento]";
    case "audio": return "[áudio]";
    case "sticker": return "[figurinha]";
    case "location": return "[localização]";
    case "contacts": return "[contato]";
    case "reaction": return `[reação ${msg.reaction?.emoji || ""}]`.trim();
    default: return `[${msg.type || "mensagem"}]`;
  }
}

function midiaIdDe(msg) {
  const m = msg[msg.type];
  return (m && typeof m === "object" && m.id) || null;
}

function normalizar(t) {
  return String(t || "")
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .toLowerCase().replace(/[.!?]+$/g, "").trim();
}

// Mesma regra do n8n ("Extrair Resposta"): só os botões da campanha contam.
function ehRespostaDaCampanha(msg) {
  if (!["text", "button", "interactive"].includes(msg.type)) return false;
  const t = normalizar(textoDaMensagem(msg));
  return t === "quero saber mais" ||
    t === "nao tenho interesse" ||
    /^(sair|parar|pare|stop|cancelar|descadastrar)$/.test(t);
}

function headersSupabase(env, extra = {}) {
  return {
    apikey: env.SUPABASE_KEY,
    Authorization: `Bearer ${env.SUPABASE_KEY}`,
    "Content-Type": "application/json",
    ...extra,
  };
}

async function gravarNoSupabase(env, tabela, linhas) {
  if (!env.SUPABASE_KEY) {
    console.log(`SUPABASE_KEY não configurada — mensagens não foram gravadas em ${tabela}`);
    return false;
  }
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/${tabela}?on_conflict=wamid`, {
      method: "POST",
      headers: headersSupabase(env, { Prefer: "resolution=ignore-duplicates,return=minimal" }),
      body: JSON.stringify(linhas),
    });
    if (!r.ok) console.log(`Supabase respondeu ${r.status}: ${await r.text()}`);
    else console.log(`Supabase: ${linhas.length} mensagem(ns) gravada(s) em ${tabela}`);
    return r.ok;
  } catch (e) {
    console.log(`Supabase inalcançável: ${e}`);
    return false;
  }
}

// ---------- Agrupamento de mensagens em sequência ----------

// Cada fila = uma tabela do Supabase usada como buffer + o webhook do n8n que recebe.
const FILA_STAR = { tabela: "star_motors_mensagens", url: N8N_STAR_AQUECIMENTO, rotulo: "Aquecimento", porNumero: false };
const FILA_CTWA = { tabela: "whatsapp_buffer", url: N8N_SOFIST, rotulo: "CTWA", porNumero: true };

function filtroDoContato(fila, telefone, phoneId) {
  const f = { telefone: `eq.${telefone}` };
  if (fila.porNumero) f.phone_number_id = `eq.${phoneId}`;
  return f;
}

// Chegou mensagem mais nova desse telefone depois desta? Então quem agrupa é ela.
async function temMensagemMaisNova(env, fila, telefone, phoneId, desde) {
  const q = new URLSearchParams({
    select: "wamid",
    ...filtroDoContato(fila, telefone, phoneId),
    recebido_em: `gt.${desde}`,
    limit: "1",
  });
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${fila.tabela}?${q}`, {
    headers: headersSupabase(env),
  });
  if (!r.ok) throw new Error(`Supabase ${r.status}: ${await r.text()}`);
  return (await r.json()).length > 0;
}

// Marca como enviadas (de forma atômica) as mensagens pendentes do telefone e
// devolve as que ESTA chamada pegou — duas chamadas nunca pegam a mesma linha.
async function pegarPendentes(env, fila, telefone, phoneId) {
  const desde = new Date(Date.now() - JANELA_PENDENTES_MS).toISOString();
  const q = new URLSearchParams({
    ...filtroDoContato(fila, telefone, phoneId),
    enviado_ao_n8n: "is.false",
    recebido_em: `gte.${desde}`,
    select: "wamid,telefone,nome,tipo,texto,raw,recebido_em",
  });
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${fila.tabela}?${q}`, {
    method: "PATCH",
    headers: headersSupabase(env, { Prefer: "return=representation" }),
    body: JSON.stringify({ enviado_ao_n8n: true }),
  });
  if (!r.ok) throw new Error(`Supabase ${r.status}: ${await r.text()}`);
  const linhas = await r.json();
  return linhas.sort((a, b) => String(a.recebido_em).localeCompare(String(b.recebido_em)));
}

async function desmarcar(env, fila, wamids) {
  if (!wamids.length) return;
  const q = new URLSearchParams({ wamid: `in.(${wamids.map((w) => `"${w}"`).join(",")})` });
  await fetch(`${SUPABASE_URL}/rest/v1/${fila.tabela}?${q}`, {
    method: "PATCH",
    headers: headersSupabase(env, { Prefer: "return=minimal" }),
    body: JSON.stringify({ enviado_ao_n8n: false }),
  }).catch((e) => console.log(`Supabase inalcançável ao desmarcar: ${e}`));
}

async function recebidoEmDe(env, fila, wamid) {
  try {
    const q = new URLSearchParams({ select: "recebido_em", wamid: `eq.${wamid}` });
    const r = await fetch(`${SUPABASE_URL}/rest/v1/${fila.tabela}?${q}`, {
      headers: headersSupabase(env),
    });
    const [l] = await r.json();
    if (l?.recebido_em) return l.recebido_em;
  } catch (e) {}
  return new Date().toISOString();
}

// Monta os payloads no formato da Meta (o n8n lê messages[0]), na ordem em que
// chegaram: cada sequência de textos vira UMA mensagem de texto com as linhas
// juntas; qualquer outro tipo (foto, áudio, botão...) vai sozinho e sem alteração.
function montarPayloadsAgrupados(base, linhas) {
  const envelope = (msg, nome) => ({
    object: base.object || "whatsapp_business_account",
    entry: [{
      id: base.entry?.[0]?.id,
      changes: [{
        field: "messages",
        value: {
          messaging_product: "whatsapp",
          metadata: base.entry?.[0]?.changes?.[0]?.value?.metadata,
          contacts: [{ profile: { name: nome || "" }, wa_id: msg.from }],
          messages: [msg],
        },
      }],
    }],
  });

  const nome = [...linhas].reverse().find((l) => l.nome)?.nome || null;
  const payloads = [];
  let textos = [];
  const fecharTextos = () => {
    if (textos.length === 0) return;
    const ultima = textos[textos.length - 1];
    // referral (anúncio de origem / ctwa_clid) costuma vir na primeira mensagem
    const referral = textos.map((r) => r.referral).find(Boolean);
    const msg = textos.length === 1 ? ultima : {
      from: ultima.from,
      id: ultima.id,
      timestamp: ultima.timestamp,
      type: "text",
      text: { body: textos.map((r) => r.text?.body || "").filter(Boolean).join("\n") },
    };
    if (referral && !msg.referral) msg.referral = referral;
    payloads.push(envelope(msg, nome));
    textos = [];
  };
  for (const l of linhas) {
    const raw = l.raw || {};
    if (raw.type === "text") { textos.push(raw); continue; }
    fecharTextos();
    payloads.push(envelope(raw, nome));
  }
  fecharTextos();
  return payloads;
}

async function agruparEEnviar(env, fila, payloadMsg, telefone, phoneId, recebidoEm, headers) {
  await new Promise((ok) => setTimeout(ok, AGRUPAR_MS));
  try {
    if (await temMensagemMaisNova(env, fila, telefone, phoneId, recebidoEm)) {
      console.log(`${fila.rotulo}: ${telefone} mandou mensagem nova — fica pra próxima`);
      return;
    }
    const linhas = await pegarPendentes(env, fila, telefone, phoneId);
    if (linhas.length === 0) return;
    const payloads = montarPayloadsAgrupados(payloadMsg, linhas);
    console.log(`${fila.rotulo}: ${linhas.length} mensagem(ns) de ${telefone} → ${payloads.length} envio(s)`);
    for (const p of payloads) {
      const ok = await entregarAoN8n(fila.url, JSON.stringify(p), headers);
      if (!ok) {
        // devolve pra fila; a próxima mensagem do cliente leva junto
        await desmarcar(env, fila, linhas.map((l) => l.wamid));
        return;
      }
    }
  } catch (e) {
    // Supabase fora: não perde a mensagem, manda do jeito antigo (uma por uma)
    console.log(`Agrupamento falhou (${e}) — enviando sem agrupar`);
    await entregarAoN8n(fila.url, JSON.stringify(payloadMsg), headers);
  }
}

function linhasDoPayload(payloadMsg) {
  const value = payloadMsg.entry[0].changes[0].value;
  const nomes = {};
  for (const c of value.contacts || []) nomes[c.wa_id] = c.profile?.name || null;
  return value.messages.map((msg) => ({
    wamid: msg.id,
    phone_number_id: value.metadata?.phone_number_id || null,
    telefone: String(msg.from || ""),
    nome: nomes[msg.from] || null,
    tipo: msg.type || null,
    texto: textoDaMensagem(msg),
    raw: msg,
    enviado_ao_n8n: false,
  }));
}

// ---------- Star Motors ----------

async function processarStarMotors(env, payloadMsg, headers) {
  const linhas = linhasDoPayload(payloadMsg).map((l) => {
    const botao = ehRespostaDaCampanha(l.raw);
    return {
      ...l,
      midia_id: midiaIdDe(l.raw),
      botao,
      enviado_em: l.raw.timestamp ? new Date(Number(l.raw.timestamp) * 1000).toISOString() : null,
    };
  });
  const temBotao = linhas.some((l) => l.botao);
  const gravou = await gravarNoSupabase(env, FILA_STAR.tabela, linhas);

  if (temBotao) await entregarAoN8n(N8N_STAR_MOTORS, JSON.stringify(payloadMsg), headers);

  if (!gravou) {
    // sem Supabase não dá pra agrupar: manda direto, como antes
    await entregarAoN8n(N8N_STAR_AQUECIMENTO, JSON.stringify(payloadMsg), headers);
    return;
  }
  const ultima = linhas[linhas.length - 1];
  const recebidoEm = await recebidoEmDe(env, FILA_STAR, ultima.wamid);
  await agruparEEnviar(env, FILA_STAR, payloadMsg, ultima.telefone, ultima.phone_number_id, recebidoEm, headers);
}

// ---------- Sofist Laser / Taynara (CTWA) ----------

async function processarCtwa(env, payloadMsg, headers) {
  const linhas = linhasDoPayload(payloadMsg);
  const gravou = await gravarNoSupabase(env, FILA_CTWA.tabela, linhas);
  if (!gravou) {
    // sem Supabase não dá pra agrupar: manda direto, como antes
    await entregarAoN8n(N8N_SOFIST, JSON.stringify(payloadMsg), headers);
    return;
  }
  // de vez em quando apaga o que já passou de 7 dias (a tabela é só um buffer)
  if (Math.random() < 0.02) {
    const q = new URLSearchParams({ recebido_em: `lt.${new Date(Date.now() - 7 * 86400000).toISOString()}` });
    await fetch(`${SUPABASE_URL}/rest/v1/${FILA_CTWA.tabela}?${q}`, {
      method: "DELETE",
      headers: headersSupabase(env, { Prefer: "return=minimal" }),
    }).catch((e) => console.log(`Limpeza do buffer falhou: ${e}`));
  }
  const ultima = linhas[linhas.length - 1];
  const recebidoEm = await recebidoEmDe(env, FILA_CTWA, ultima.wamid);
  await agruparEEnviar(env, FILA_CTWA, payloadMsg, ultima.telefone, ultima.phone_number_id, recebidoEm, headers);
}

// ---------- Worker ----------

const OK = () =>
  new Response('{"status":"ok"}', { status: 200, headers: { "Content-Type": "application/json" } });

export default {
  async fetch(request, env, ctx) {
    if (request.method === "GET") {
      // Verificação do webhook pela Meta (hub.challenge) — respondida aqui,
      // sem depender do n8n estar ligado.
      const url = new URL(request.url);
      const token = env.VERIFY_TOKEN || VERIFY_TOKEN_PADRAO;
      if (url.searchParams.get("hub.mode") === "subscribe" &&
          url.searchParams.get("hub.verify_token") === token) {
        return new Response(url.searchParams.get("hub.challenge") || "", { status: 200 });
      }
      return new Response("Forbidden", { status: 403 });
    }
    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405 });
    }

    const bodyText = await request.text();
    const headers = montarHeaders(request);

    let payload;
    try {
      payload = JSON.parse(bodyText);
    } catch (e) {
      ctx.waitUntil(entregarAoN8n(N8N_SOFIST, bodyText, headers));
      return OK();
    }

    // Registro de diagnóstico: o que a Meta mandou (sem conteúdo das mensagens).
    for (const entry of payload?.entry || []) {
      for (const change of entry?.changes || []) {
        const v = change?.value || {};
        console.log(JSON.stringify({
          field: change?.field,
          phone_number_id: v.metadata?.phone_number_id,
          numero: v.metadata?.display_phone_number,
          mensagens: (v.messages || []).map((m) => m.type),
          status: (v.statuses || []).map((s) => s.status),
          rota: v.metadata?.phone_number_id === PHONE_STAR_MOTORS ? "star_motors" : "sofist",
        }));
      }
    }

    const mensagens = mensagensDoPayload(payload);
    if (mensagens.length === 0) {
      return new Response('{"status":"ignored"}', {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Cada mensagem num POST próprio (o n8n só lê entry[0].changes[0]). Em
    // paralelo: cada uma espera AGRUPAR_MS e o waitUntil tem limite de ~30s.
    ctx.waitUntil(
      Promise.all(mensagens.map((m) =>
        phoneIdDe(m) === PHONE_STAR_MOTORS ? processarStarMotors(env, m, headers) : processarCtwa(env, m, headers)
      ))
    );
    return OK();
  },
};
