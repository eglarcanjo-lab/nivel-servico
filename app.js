'use strict';
/* =========================================================================
   Nível de Serviço — app pessoal offline
   Módulos: Hoje (iniciar dia) · Agenda · Visitas/checklist · Pendências e
   planos de ação · Promotores · Base de clientes · Cadastros
   Dados ficam só no aparelho (IndexedDB). Backup em JSON, exportação em CSV.
   ========================================================================= */

/* ---------- utilidades ---------- */
const $ = (s, r = document) => r.querySelector(s);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const norm = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
const normCod = (c) => { const s = String(c ?? '').trim(); return /^\d+$/.test(s) ? String(parseInt(s, 10)) : s; };

const pad = (n) => String(n).padStart(2, '0');
const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parse = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const addDays = (s, n) => { const d = parse(s); d.setDate(d.getDate() + n); return iso(d); };
const dow = (s) => { const g = parse(s).getDay(); return g === 0 ? 7 : g; }; // 1=Seg … 7=Dom
const monday = (s) => addDays(s, 1 - dow(s));
const today = () => iso(new Date());
const weeksBetween = (a, b) => Math.round((parse(monday(b)) - parse(monday(a))) / (7 * 864e5));
const fmtBR = (s) => { if (!s) return ''; const d = parse(s); return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}`; };
const mesAno = (s) => parse(s).toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' });
const nowHM = () => { const d = new Date(); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const hm = (isoTs) => { if (!isoTs) return ''; const d = new Date(isoTs); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const pctTxt = (p) => (p == null ? '—' : `${Math.round(p * 100)}%`);

const DIAS = ['', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb', 'Dom'];
const DIA_VDE = ['', 'SEG', 'TER', 'QUA', 'QUI', 'SEX', 'SAB', 'DOM'];
const DIAS_SEMANA = [1, 2, 3, 4, 5, 6];
const TURNOS = { M: 'Manhã', T: 'Tarde', D: 'Dia todo' };
const TURNO_ORD = { M: 0, D: 1, T: 2 };
const TIPOS = { RN: 'Rota com RN', PROM: 'Rota com Promotor', IND: 'Rota independente', INT: 'Interno' };
const TIPO_CURTO = { RN: 'RN', PROM: 'PROM', IND: 'IND', INT: 'INT' };
const STATUS = { plan: 'Planejado', ok: 'Realizado', nao: 'Não realizado', reag: 'Reagendado' };
const STATUS_ICO = { plan: 'Planejado', ok: '✓ Feito', nao: '✗ Não', reag: '↻ Reag.' };
const PERIODOS = { 1: 'Semanal', 2: 'Quinzenal', 4: 'Mensal (a cada 4 sem.)' };
const RESP = ['Sim', 'Não', 'N/A'];

/* ---------- banco local (IndexedDB) ---------- */
const STORES = ['colaboradores', 'pdvs', 'agenda', 'config', 'clientes', 'pdvInfo', 'visitas', 'pendencias', 'planos', 'fotos'];
const MEM_STORES = STORES.filter((s) => s !== 'config' && s !== 'fotos'); // ficam em memória
let db;
function openDB() {
  return new Promise((res, rej) => {
    const r = indexedDB.open('nivel-servico', 2);
    r.onupgradeneeded = () => {
      const d = r.result;
      for (const s of STORES) {
        if (d.objectStoreNames.contains(s)) continue;
        const os = d.createObjectStore(s, { keyPath: 'id' });
        if (s === 'fotos') os.createIndex('visitaId', 'visitaId');
      }
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
function tx(store, mode, fn) {
  return new Promise((res, rej) => {
    const t = db.transaction(store, mode);
    const out = fn(t.objectStore(store));
    t.oncomplete = () => res(out && 'result' in out ? out.result : undefined);
    t.onerror = () => rej(t.error);
    t.onabort = () => rej(t.error);
  });
}
const dbAll = (s) => tx(s, 'readonly', (os) => os.getAll());
const dbGet = (s, id) => tx(s, 'readonly', (os) => os.get(id));
const dbPut = (s, o) => tx(s, 'readwrite', (os) => os.put(o));
const dbPutMany = (s, arr) => tx(s, 'readwrite', (os) => { for (const o of arr) os.put(o); });
const dbDel = (s, id) => tx(s, 'readwrite', (os) => os.delete(id));
const dbClear = (s) => tx(s, 'readwrite', (os) => os.clear());

/* ---------- estado em memória ---------- */
const S = { config: null };
for (const s of MEM_STORES) S[s] = [];

async function save(store, obj) {
  obj.atualizado = new Date().toISOString();
  const arr = S[store];
  const i = arr.findIndex((x) => x.id === obj.id);
  if (i >= 0) arr[i] = obj; else arr.push(obj);
  await dbPut(store, obj);
}
async function remove(store, id) {
  S[store] = S[store].filter((x) => x.id !== id);
  await dbDel(store, id);
}
async function saveConfig() { await dbPut('config', S.config); }

const DEFAULT_CFG = {
  focos: ['Execução de PDV', 'Cobertura / Positivação', 'Pendências', 'Ativação de clientes', 'Merchandising / Ponto extra', 'Ruptura / Abastecimento', 'Possível CT', 'Treinamento do colaborador'],
  motivos: ['Reunião de Nível de Serviço', 'Relatórios / KPIs', 'Tratativa de pendências', 'Reunião com gerente', 'Treinamento', 'Administrativo'],
  checkRN: ['Menu NAB', 'Menu Cerveja', 'Cartazete', 'Cartão Preço', 'Bandô', 'Faixa'],
  checkPROM: ['Abastecimento de Gôndola', 'Precificação', 'FIFO / Validade', 'Limpeza de Geladeira', 'Ponto Extra', 'Planograma', 'Sem Ruptura'],
  tiposCT: ['Comodato', 'Acordo Comercial', 'Bonificação', 'Material de PDV', 'Visibilidade / Espaço', 'Outro'],
  minExec: 100,   // % mínimo para visita RN/independente contar como "Executado"
  minPdvsRN: 10,  // dia com RN conta se visitar MAIS DE N PDVs
};
const cfg = () => S.config;

async function load() {
  db = await openDB();
  for (const s of MEM_STORES) S[s] = await dbAll(s);
  const conf = (await dbAll('config')).find((c) => c.id === 'main');
  if (!conf) {
    S.config = Object.assign({ id: 'main', ultimoBackup: null, criado: new Date().toISOString() }, structuredClone(DEFAULT_CFG));
    await saveConfig();
    let o = 0;
    // Nomes genéricos de propósito: o código é público. Renomeie em Cadastros.
    for (let i = 1; i <= 10; i++) await save('colaboradores', { id: uid(), nome: `RN ${pad(i)}`, tipo: 'RN', ativo: true, ordem: o++ });
    for (let i = 1; i <= 2; i++) await save('colaboradores', { id: uid(), nome: `Promotor ${pad(i)}`, tipo: 'PROM', ativo: true, ordem: o++ });
  } else {
    S.config = Object.assign(structuredClone(DEFAULT_CFG), conf); // completa campos novos
  }
  buildIndex();
}

/* ---------- consultas ---------- */
const colabs = (tipo, incluirInativos = false) =>
  S.colaboradores.filter((c) => c.tipo === tipo && (incluirInativos || c.ativo !== false))
    .sort((a, b) => (a.ordem ?? 0) - (b.ordem ?? 0) || a.nome.localeCompare(b.nome));
const colab = (id) => S.colaboradores.find((c) => c.id === id);
const colabNome = (id) => colab(id)?.nome || '(removido)';

let CLI = new Map(), CLI_IDX = [];
function buildIndex() {
  CLI = new Map(S.clientes.map((c) => [c.id, c]));
  CLI_IDX = S.clientes.map((c) => [norm(`${c.id} ${c.fantasia} ${c.razao} ${c.bairro} ${c.cidade}`), c]);
}
const cliente = (cod) => CLI.get(normCod(cod));
const nomeCli = (c) => (c?.fantasia || c?.razao || '').trim();
const geo = (cod) => S.pdvInfo.find((x) => x.id === normCod(cod) && x.lat != null);
function buscaClientes(q, max = 40) {
  const t = norm(q).split(' ').filter(Boolean);
  if (!t.length) return [];
  const out = [];
  for (const [s, c] of CLI_IDX) { if (t.every((w) => s.includes(w))) { out.push(c); if (out.length >= max) break; } }
  return out;
}

/* Roteiro do promotor: quais PDVs ele visita numa data */
function pdvsDoDia(promId, data) {
  const d = dow(data);
  return S.pdvs.filter((p) => {
    if (p.promotorId !== promId || p.ativo === false || !p.dias?.includes(d)) return false;
    const n = Number(p.cadaSemanas) || 1;
    if (n === 1) return true;
    const ini = p.inicio || data;
    if (data < monday(ini)) return false;
    return ((weeksBetween(ini, data) % n) + n) % n === 0;
  }).sort((a, b) => a.nome.localeCompare(b.nome));
}

const visitasDe = (agendaId) => S.visitas.filter((v) => v.agendaId === agendaId).sort((a, b) => (a.hora || '').localeCompare(b.hora || ''));
const checklist = (tipo) => (tipo === 'PROM' ? cfg().checkPROM : cfg().checkRN);
function execPct(itens) {
  if (!itens?.some((i) => i.r)) return null;
  const aplic = itens.filter((i) => i.r !== 'N/A').length;
  if (!aplic) return null;
  return itens.filter((i) => i.r === 'Sim').length / aplic;
}
const minExecDe = (tipo) => (tipo === 'PROM' ? 1 : (Number(cfg().minExec) || 100) / 100);
const isExec = (v) => { const p = execPct(v.itens); return p != null && p >= minExecDe(v.tipo) - 1e-9; };
const pendAbertas = (cod) => S.pendencias.filter((p) => p.codigo === normCod(cod) && !p.resolvida);
const whoEntry = (a) => (a.tipo === 'INT' ? (a.motivo || 'Interno') : a.tipo === 'IND' ? 'Rota independente' : colabNome(a.colabId));

/* ---------- estado da interface ---------- */
const ui = Object.assign({ promId: null, promTab: 'agenda', pendTab: 'pend', pendFiltro: 'abertas' }, (() => {
  try { return JSON.parse(localStorage.getItem('ns-ui') || '{}'); } catch { return {}; }
})());
Object.assign(ui, { week: monday(today()), busca: '', pendBusca: '', baseBusca: '' });
const saveUI = () => { try { localStorage.setItem('ns-ui', JSON.stringify({ promId: ui.promId, promTab: ui.promTab, pendTab: ui.pendTab, pendFiltro: ui.pendFiltro })); } catch {} };

/* ---------- feedback ---------- */
let toastT;
function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), 2400);
}

/* ---------- diálogo genérico ---------- */
const dlg = $('#dlg'), dform = $('#dlgform');
let dlgHandlers = {};
function openDialog(html, handlers = {}) {
  dform.innerHTML = html;
  dlgHandlers = handlers;
  if (!dlg.open) dlg.showModal();
  dform.scrollTop = 0; dlg.scrollTop = 0;
  handlers.onOpen?.(dform);
  const first = dform.querySelector('[autofocus]');
  if (first && matchMedia('(min-width: 600px)').matches) first.focus();
}
function closeDialog() {
  if (!dlg.open) return;
  const h = dlgHandlers; dlgHandlers = {};
  dlg.close(); dform.innerHTML = '';
  h.onClose?.();
}
dform.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (dlgHandlers.onSubmit) {
    const ok = await dlgHandlers.onSubmit(dform);
    if (ok !== false) { closeDialog(); render(); }
  }
});
dform.addEventListener('change', (e) => dlgHandlers.onChange?.(dform, e));
dlg.addEventListener('cancel', (e) => { e.preventDefault(); closeDialog(); });
dlg.addEventListener('click', (e) => { if (e.target === dlg) closeDialog(); });

const viewer = $('#viewer');
viewer.addEventListener('click', () => viewer.close());
function showPhoto(src) { $('#viewer img').src = src; viewer.showModal(); }

const radios = (name, map, val) =>
  Object.entries(map).map(([k, v]) => `<label><input type="radio" name="${name}" value="${esc(k)}" ${String(val) === String(k) ? 'checked' : ''}><span>${esc(v)}</span></label>`).join('');
const radiosList = (name, list, val) => radios(name, Object.fromEntries(list.map((x) => [x, x])), val);
const daysPicker = (sel = []) =>
  `<div class="chips">${DIAS_SEMANA.map((d) => `<label><input type="checkbox" name="dias" value="${d}" ${sel.includes(d) ? 'checked' : ''}><span>${DIAS[d]}</span></label>`).join('')}</div>`;
const options = (list, val, placeholder) =>
  (placeholder ? `<option value="">${esc(placeholder)}</option>` : '') +
  list.map((o) => `<option value="${esc(o.v)}" ${String(o.v) === String(val) ? 'selected' : ''}>${esc(o.t)}</option>`).join('');
const pctClass = (p, tipo) => (p == null ? '' : p >= minExecDe(tipo) - 1e-9 ? 'good' : p >= 0.5 ? 'mid' : 'bad');

/* =========================================================================
   HOJE — iniciar o dia
   ========================================================================= */
function viewHoje() {
  const d = today();
  const ents = S.agenda.filter((a) => a.data === d).sort((a, b) => TURNO_ORD[a.turno] - TURNO_ORD[b.turno]);
  const pend = S.pendencias.filter((p) => !p.resolvida).length;
  const atras = S.planos.filter((p) => !p.feito && p.prazo && p.prazo < d).length;
  const turnoAgora = new Date().getHours() < 12 ? 'M' : 'T';
  return `<div class="hoje-head"><div><h1>${DIAS[dow(d)]}, ${fmtBR(d)}</h1><small>${mesAno(d)}</small></div></div>
    <div class="stats">
      <a class="stat" href="#/pendencias"><b>${pend}</b><span>pendência(s) aberta(s)</span></a>
      <a class="stat ${atras ? 'warn' : ''}" href="#/pendencias" data-act="pend-tab" data-tab="planos"><b>${atras}</b><span>plano(s) de ação atrasado(s)</span></a>
    </div>
    <h2 class="sec">Compromissos de hoje</h2>
    ${ents.length ? `<div class="bigs">${ents.map(bigCard).join('')}</div>` : '<div class="empty">Nada na agenda para hoje.</div>'}
    <div class="ctas">
      <button class="primary" data-act="new-entry" data-date="${d}" data-turno="${turnoAgora}" data-tipo="IND" data-go="1">▶ Rota independente agora</button>
      <button data-act="new-entry" data-date="${d}" data-turno="${turnoAgora}" data-go="1">+ Outro compromisso hoje</button>
    </div>`;
}

function bigCard(a) {
  const vs = visitasDe(a.id);
  const foco = [...(a.focos || []), a.focoTxt].filter(Boolean).join(' · ');
  const estado = a.fim ? `Encerrado ${hm(a.inicio)}–${hm(a.fim)}` : a.inicio ? `Em andamento desde ${hm(a.inicio)}` : STATUS[a.status];
  const btn = a.fim ? 'Ver' : a.inicio ? 'Continuar ▶' : 'Iniciar ▶';
  const extra = a.tipo === 'INT' ? `${S.planos.filter((p) => p.agendaId === a.id).length} plano(s) de ação` : `${vs.length} PDV(s) visitado(s) · ${vs.filter(isExec).length} executado(s)`;
  return `<a class="big t-${a.tipo}" href="#/dia/${a.id}">
    <span class="l1"><span class="badge">${TIPO_CURTO[a.tipo]}</span><b>${esc(whoEntry(a))}</b><small>${TURNOS[a.turno]}</small></span>
    ${foco ? `<span class="foco">🎯 ${esc(foco)}</span>` : ''}
    <span class="l3"><small>${estado} · ${extra}</small><span class="go">${btn}</span></span>
  </a>`;
}

/* =========================================================================
   EXECUÇÃO DO COMPROMISSO (#/dia/<id>)
   ========================================================================= */
function viewDia(id) {
  const a = S.agenda.find((x) => x.id === id);
  if (!a) return '<div class="empty">Compromisso não encontrado. <a href="#/hoje">Voltar</a></div>';
  const foco = [...(a.focos || []), a.focoTxt].filter(Boolean).join(' · ');
  const det = a.tipo === 'INT' ? a.motivoTxt : a.rota;
  return `<a class="back" href="#/hoje">‹ Hoje</a>
    <section class="exec-head t-${a.tipo}">
      <div class="l1"><span class="badge">${TIPO_CURTO[a.tipo]}</span><h1>${esc(whoEntry(a))}</h1></div>
      <small>${DIAS[dow(a.data)]} ${fmtBR(a.data)} · ${TURNOS[a.turno]}${det ? ' · ' + esc(det) : ''}</small>
      ${foco ? `<div class="foco">🎯 <b>Foco:</b> ${esc(foco)}</div>` : '<div class="foco muted">Sem foco definido</div>'}
      <div class="exec-actions">
        ${a.fim ? `<span class="pill done">Encerrado ${hm(a.inicio)}–${hm(a.fim)}</span><button class="sm ghost" data-act="entry-reopen" data-id="${a.id}">Reabrir</button>`
          : a.inicio ? `<span class="pill plan">Iniciado às ${hm(a.inicio)}</span><button class="primary" data-act="entry-end" data-id="${a.id}">Encerrar</button>`
          : `<button class="primary" data-act="entry-start" data-id="${a.id}">▶ Iniciar</button>`}
        <button class="sm ghost" data-act="edit-entry" data-id="${a.id}">Editar</button>
      </div>
    </section>
    ${a.tipo === 'INT' ? intSection(a) : routeSection(a)}`;
}

function routeSection(a) {
  const vs = visitasDe(a.id);
  const ex = vs.filter(isExec).length;
  const pend = S.pendencias.filter((p) => p.agendaId === a.id);
  const ct = vs.filter((v) => v.possivelCT === 'Sim').length;
  const min = Number(cfg().minPdvsRN) || 0;
  const meta = a.tipo === 'RN' ? `<small class="${vs.length > min ? 'okc' : ''}">${vs.length > min ? '✓ dia válido' : `meta: mais de ${min}`}</small>` : '';
  return `<div class="kpis">
      <div class="kpi"><b>${vs.length}</b><span>PDVs visitados</span>${meta}</div>
      <div class="kpi"><b>${ex}</b><span>Executados</span><small>${vs.length ? pctTxt(ex / vs.length) : '—'}</small></div>
      <div class="kpi"><b>${pend.filter((p) => !p.resolvida).length}</b><span>Pendências abertas</span><small>${pend.length} lançada(s)</small></div>
      <div class="kpi"><b>${ct}</b><span>Possível CT</span></div>
    </div>
    <button class="primary wide" data-act="visita-add" data-agenda="${a.id}">+ Registrar PDV visitado</button>
    ${vs.length ? `<div class="vlist">${vs.map(visitCard).join('')}</div>` : '<div class="empty">Nenhum PDV registrado ainda.</div>'}`;
}

function visitCard(v) {
  const p = execPct(v.itens);
  const np = S.pendencias.filter((x) => x.visitaId === v.id).length;
  return `<button class="vcard" data-act="visita-edit" data-id="${v.id}">
    <span class="main"><b>${esc(v.nome)}</b><small>${esc(v.codigo)} · ${esc(v.hora)}${v.possivelCT === 'Sim' ? ' · CT' : ''}</small></span>
    <span class="icons">${v.fotos?.length ? `📷${v.fotos.length}` : ''} ${np ? `⚠️${np}` : ''} ${geo(v.codigo) ? '📍' : ''}</span>
    <span class="pct ${pctClass(p, v.tipo)}">${pctTxt(p)}</span>
  </button>`;
}

function intSection(a) {
  const planos = S.planos.filter((p) => p.agendaId === a.id).sort(planoSort);
  return `<section class="card">
      <h3>Notas / ata</h3>
      <textarea rows="6" data-entry-field="notas" data-id="${a.id}" placeholder="O que foi tratado…">${esc(a.notas)}</textarea>
      <span class="hint">Salva automaticamente.</span>
    </section>
    <section class="card">
      <h3>Planos de ação</h3>
      <div class="addplano">
        <input id="pa-acao" placeholder="O que fazer">
        <input id="pa-resp" placeholder="Responsável">
        <input id="pa-prazo" type="date" aria-label="Prazo">
        <button data-act="plano-add" data-agenda="${a.id}">Adicionar</button>
      </div>
      ${planos.length ? `<div class="checks">${planos.map(planoItem).join('')}</div>` : '<span class="hint">Nenhum plano de ação ainda.</span>'}
    </section>`;
}

const planoSort = (a, b) => (a.feito - b.feito) || (a.prazo || '9').localeCompare(b.prazo || '9');
function planoItem(p) {
  const late = !p.feito && p.prazo && p.prazo < today();
  return `<div class="check ${p.feito ? 'done' : ''}">
    <input type="checkbox" data-plano="${p.id}" ${p.feito ? 'checked' : ''} aria-label="Concluído">
    <span class="txt"><b>${esc(p.acao)}</b><small>${p.resp ? esc(p.resp) + ' · ' : ''}${p.prazo ? `<span class="${late ? 'late' : ''}">prazo ${fmtBR(p.prazo)}</span>` : 'sem prazo'}${p.feito && p.feitoEm ? ` · feito ${fmtBR(p.feitoEm)}` : ''}${p.origem ? ' · ' + esc(p.origem) : ''}</small></span>
    <button class="icon sm danger" data-act="plano-del" data-id="${p.id}" aria-label="Excluir">×</button>
  </div>`;
}

/* ----- escolher PDV para a visita ----- */
function sugestoes(a) {
  if (a.tipo === 'RN') {
    const c = colab(a.colabId);
    if (!c?.setor) return { titulo: 'Dica: defina o Setor VDE deste RN em Cadastros para ver os PDVs dele aqui.', list: [] };
    const dia = DIA_VDE[dow(a.data)];
    const doSetor = S.clientes.filter((x) => x.setor === c.setor);
    const doDia = doSetor.filter((x) => (x.diaVisita || '').includes(dia));
    return doDia.length ? { titulo: `Setor ${c.setor} · visita de ${dia} (${doDia.length})`, list: doDia } : { titulo: `Setor ${c.setor} (${doSetor.length})`, list: doSetor };
  }
  if (a.tipo === 'PROM') {
    const ps = pdvsDoDia(a.colabId, a.data).map((p) => cliente(p.codigo) || { id: normCod(p.codigo) || p.id, fantasia: p.nome, bairro: p.bairro });
    return { titulo: `Roteiro do promotor (${ps.length})`, list: ps };
  }
  const cods = [...new Set(S.pendencias.filter((p) => !p.resolvida).map((p) => p.codigo))];
  const list = cods.map((c) => cliente(c) || { id: c, fantasia: S.pendencias.find((p) => p.codigo === c)?.nomePdv });
  return { titulo: `PDVs com pendência aberta (${list.length})`, list };
}

function openPicker(a) {
  const feitos = new Set(visitasDe(a.id).map((v) => v.codigo));
  const sug = sugestoes(a);
  const item = (c) => {
    const np = pendAbertas(c.id).length;
    return `<button type="button" class="item ${feitos.has(c.id) ? 'off' : ''}" data-act="pick" data-cod="${esc(c.id)}">
      <span class="main"><b>${esc(nomeCli(c) || c.id)}</b><small>${esc(c.id)}${c.bairro ? ' · ' + esc(c.bairro) : ''}${c.cidade ? ' · ' + esc(c.cidade) : ''}${c.diaVisita ? ' · ' + esc(c.diaVisita) : ''}</small></span>
      <span class="icons">${feitos.has(c.id) ? '✓' : ''}${np ? ` ⚠️${np}` : ''}${geo(c.id) ? ' 📍' : ''}</span></button>`;
  };
  const lista = (q) => {
    if (!q.trim()) {
      return `<p class="hint">${esc(sug.titulo)}</p>${sug.list.length ? `<div class="list">${sug.list.slice(0, 200).map(item).join('')}</div>` : ''}`;
    }
    const r = buscaClientes(q);
    return (r.length ? `<div class="list">${r.map(item).join('')}</div>` : `<p class="hint">Nenhum cliente ativo encontrado${S.clientes.length ? '' : ' (a base de clientes ainda não foi importada — veja Cadastros)'}.</p>`)
      + `<button type="button" class="sm" data-act="pick-manual">+ Usar "${esc(q.trim())}" como PDV fora da base</button>`;
  };
  openDialog(`<h2>Registrar PDV visitado</h2>
    <input type="search" id="pk-q" placeholder="Código, nome, bairro ou cidade" autocomplete="off" autofocus>
    <div id="pk-list">${lista('')}</div>
    <div class="dlg-actions"><span class="sp"></span><button type="button" class="ghost" data-act="close">Fechar</button></div>`, {
    onOpen(f) { $('#pk-q', f).addEventListener('input', (e) => { $('#pk-list', f).innerHTML = lista(e.target.value); }); },
    onSubmit() { return false; },
    actions: {
      pick: (b) => criarVisita(a, b.dataset.cod),
      'pick-manual': () => {
        const nome = $('#pk-q').value.trim();
        const cod = prompt('Código do PDV (deixe em branco se não souber):', '') ?? null;
        if (cod === null) return;
        criarVisita(a, normCod(cod) || `SEM-${uid().slice(-5).toUpperCase()}`, nome);
      },
    },
    onClose: render,
  });
}

async function criarVisita(a, cod, nomeManual) {
  cod = normCod(cod);
  const ja = visitasDe(a.id).find((v) => v.codigo === cod);
  if (ja) { openVisita(ja.id); return; }
  const c = cliente(cod);
  const promPdv = S.pdvs.find((p) => normCod(p.codigo) === cod);
  const v = {
    id: uid(), agendaId: a.id, data: a.data, tipo: a.tipo, colabId: a.colabId || '',
    codigo: cod, nome: nomeManual || nomeCli(c) || promPdv?.nome || cod, hora: nowHM(),
    itens: checklist(a.tipo).map((n) => ({ n, r: '' })), aderido: '', possivelCT: '', tipoCT: '', obs: '', fotos: [],
    criado: new Date().toISOString(),
  };
  await save('visitas', v);
  if (!a.inicio) { a.inicio = new Date().toISOString(); await save('agenda', a); }
  openVisita(v.id);
}

/* ----- formulário da visita (salva sozinho) ----- */
function geoBlock(cod) {
  const g = geo(cod);
  if (!g) return `<button type="button" class="geo-btn" data-act="geo-save" data-cod="${esc(cod)}">📍 Marcar minha localização atual como local deste PDV</button>`;
  const ll = `${g.lat},${g.lng}`;
  return `<div class="geo ok"><span>📍 Local salvo em ${new Date(g.geoEm).toLocaleDateString('pt-BR')} <small>(±${Math.round(g.acc || 0)} m)</small></span>
    <span class="geo-links"><a href="https://www.google.com/maps/search/?api=1&query=${ll}" target="_blank" rel="noopener">Ver no mapa</a>
    <a href="https://www.google.com/maps/dir/?api=1&destination=${ll}" target="_blank" rel="noopener">Como chegar</a>
    <button type="button" class="sm ghost" data-act="geo-save" data-cod="${esc(cod)}">Atualizar</button></span></div>`;
}

function pendBlock(cod, visita) {
  const all = S.pendencias.filter((p) => p.codigo === normCod(cod)).sort((a, b) => a.resolvida - b.resolvida || (b.criada || '').localeCompare(a.criada || ''));
  const abertas = all.filter((p) => !p.resolvida), resolv = all.filter((p) => p.resolvida);
  return `${abertas.length ? `<div class="checks">${abertas.map(pendItem).join('')}</div>` : '<span class="hint">Nenhuma pendência aberta neste PDV.</span>'}
    ${resolv.length ? `<details><summary class="hint">${resolv.length} resolvida(s)</summary><div class="checks">${resolv.map(pendItem).join('')}</div></details>` : ''}
    ${visita ? `<div class="addrow"><input id="pend-new" placeholder="Nova pendência deste PDV…" enterkeyhint="done"><button type="button" data-act="pend-add">Adicionar</button></div>` : ''}`;
}

function pendItem(p, comPdv) {
  return `<div class="check ${p.resolvida ? 'done' : ''}">
    <input type="checkbox" data-pend="${p.id}" ${p.resolvida ? 'checked' : ''} aria-label="Resolvida">
    <span class="txt"><b>${esc(p.descricao)}</b><small>${comPdv === true ? `<a href="#" data-act="pdv-detail" data-cod="${esc(p.codigo)}">${esc(p.nomePdv || p.codigo)}</a> · ` : ''}aberta ${fmtBR(p.criada)}${p.colabId ? ' · ' + esc(colabNome(p.colabId)) : ''}${p.resolvida ? ` · resolvida ${fmtBR(p.resolvidaEm)}` : ''}</small></span>
  </div>`;
}

function openVisita(id) {
  const v = S.visitas.find((x) => x.id === id);
  if (!v) return;
  const c = cliente(v.codigo);
  const tipos = cfg().tiposCT;
  const html = `<div class="vhead"><h2>${esc(v.nome)}</h2>
      <small>${esc(v.codigo)}${c ? ` · ${esc(c.bairro)} · ${esc(c.cidade)} · ${esc(c.categoria)}` : ''} · ${esc(v.hora)}</small></div>
    <div id="v-geo">${geoBlock(v.codigo)}</div>
    <fieldset class="ckset"><legend>Execução <b id="v-pct" class="pct"></b></legend>
      <div class="ck-tools"><button type="button" class="sm" data-act="all-sim">Tudo Sim</button></div>
      ${v.itens.map((it, i) => `<div class="ck"><span>${esc(it.n)}</span><div class="seg3">${RESP.map((r) => `<label><input type="radio" name="it${i}" value="${r}" ${it.r === r ? 'checked' : ''}><span>${r}</span></label>`).join('')}</div></div>`).join('')}
    </fieldset>
    ${v.tipo !== 'PROM' ? `<fieldset class="ckset"><legend>Check list geral</legend>
      <div class="ck"><span>PDV aderido</span><div class="seg3">${radiosList('aderido', ['Sim', 'Não'], v.aderido)}</div></div>
      <div class="ck"><span>Possível CT</span><div class="seg3">${radiosList('possivelCT', ['Sim', 'Não'], v.possivelCT)}</div></div>
      <label id="v-tipoct" ${v.possivelCT === 'Sim' ? '' : 'hidden'}>Tipo de CT<select name="tipoCT">${options(tipos.map((t) => ({ v: t, t })), v.tipoCT, 'Escolha…')}</select></label>
    </fieldset>` : ''}
    <fieldset class="ckset"><legend>Pendências do PDV</legend><div id="v-pend">${pendBlock(v.codigo, v)}</div></fieldset>
    <fieldset class="ckset"><legend>Fotos</legend>
      <div id="v-fotos" class="thumbs"></div>
      <label class="filebtn"><input type="file" accept="image/*" multiple name="fotos"><span>📷 Tirar / anexar fotos</span></label>
    </fieldset>
    <label>${v.tipo === 'PROM' ? 'Ocorrência / Observação' : 'Observações'}<textarea name="obs" rows="3">${esc(v.obs)}</textarea></label>
    <div class="dlg-actions"><button type="button" class="danger" data-act="visita-del">Excluir visita</button><span class="sp"></span>
      <span class="hint">Salvo automaticamente</span><button type="button" class="primary" data-act="close">Concluir</button></div>`;

  const updPct = () => { const p = execPct(v.itens); const el = $('#v-pct'); if (el) { el.textContent = p == null ? '' : `${pctTxt(p)} ${isExec(v) ? '· Executado' : '· Não executado'}`; el.className = `pct ${pctClass(p, v.tipo)}`; } };
  const saveV = async () => {
    const fd = new FormData(dform);
    v.itens.forEach((it, i) => { it.r = fd.get(`it${i}`) || ''; });
    if (v.tipo !== 'PROM') { v.aderido = fd.get('aderido') || ''; v.possivelCT = fd.get('possivelCT') || ''; v.tipoCT = v.possivelCT === 'Sim' ? (fd.get('tipoCT') || '') : ''; }
    v.obs = (fd.get('obs') || '').trim();
    await save('visitas', v); updPct();
  };
  const refresh = () => {
    const p = $('#v-pend'); if (p) p.innerHTML = pendBlock(v.codigo, v);
    const g = $('#v-geo'); if (g) g.innerHTML = geoBlock(v.codigo);
  };
  const addPend = async () => {
    const inp = $('#pend-new'); const t = inp?.value.trim(); if (!t) return;
    await save('pendencias', { id: uid(), codigo: v.codigo, nomePdv: v.nome, descricao: t, criada: v.data, visitaId: v.id, agendaId: v.agendaId, colabId: v.colabId, tipo: v.tipo, resolvida: false, resolvidaEm: null });
    refresh(); $('#pend-new')?.focus(); toast('Pendência adicionada');
  };
  let obsT;
  openDialog(html, {
    onOpen(f) {
      updPct(); renderThumbs($('#v-fotos', f), v, true);
      $('[name="obs"]', f).addEventListener('input', () => { clearTimeout(obsT); obsT = setTimeout(saveV, 600); });
    },
    async onChange(f, e) {
      const n = e.target.name;
      if (e.target.dataset.pend) return; // tratado globalmente
      if (n === 'fotos') { await addFotos(e.target.files, v); e.target.value = ''; return; }
      if (n === 'possivelCT') $('#v-tipoct', f).hidden = e.target.value !== 'Sim';
      if (n) await saveV();
    },
    onSubmit() { if (document.activeElement?.id === 'pend-new') addPend(); return false; },
    refresh,
    actions: {
      'all-sim': async () => { dform.querySelectorAll('.ckset .seg3 input[value="Sim"]').forEach((r) => { if (/^it\d+$/.test(r.name)) r.checked = true; }); await saveV(); },
      'pend-add': addPend,
      'foto-del': async (b) => {
        if (!confirm('Excluir esta foto?')) return;
        await dbDel('fotos', b.dataset.id); v.fotos = v.fotos.filter((x) => x !== b.dataset.id); await save('visitas', v);
        renderThumbs($('#v-fotos'), v, true);
      },
      'visita-del': async () => {
        if (!confirm(`Excluir a visita em ${v.nome}? As fotos dela também serão apagadas (as pendências continuam).`)) return;
        for (const fid of v.fotos || []) await dbDel('fotos', fid);
        await remove('visitas', v.id); closeDialog(); toast('Visita excluída');
      },
    },
    async onClose() { clearTimeout(obsT); render(); },
  });
}

/* ----- fotos ----- */
async function compress(file) {
  try {
    const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
    const max = 1600, s = Math.min(1, max / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas');
    c.width = Math.round(bmp.width * s); c.height = Math.round(bmp.height * s);
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    bmp.close?.();
    return await new Promise((r) => c.toBlob((b) => r(b || file), 'image/jpeg', 0.72));
  } catch { return file; }
}
async function addFotos(files, v) {
  if (!files?.length) return;
  toast('Processando foto(s)…');
  for (const f of files) {
    const blob = await compress(f);
    const id = uid();
    await dbPut('fotos', { id, visitaId: v.id, codigo: v.codigo, data: v.data, blob, criado: new Date().toISOString() });
    v.fotos = [...(v.fotos || []), id];
  }
  await save('visitas', v);
  renderThumbs($('#v-fotos'), v, true);
  toast(`${files.length} foto(s) salva(s)`);
}
let thumbURLs = [];
async function renderThumbs(el, v, canDel) {
  if (!el) return;
  thumbURLs.forEach((u) => URL.revokeObjectURL(u)); thumbURLs = [];
  const fotos = (await Promise.all((v.fotos || []).map((id) => dbGet('fotos', id)))).filter(Boolean);
  el.innerHTML = fotos.map((f) => { const u = URL.createObjectURL(f.blob); thumbURLs.push(u); return `<div class="thumb"><img src="${u}" alt="Foto" data-view="${u}">${canDel ? `<button type="button" data-act="foto-del" data-id="${f.id}" aria-label="Excluir foto">×</button>` : ''}</div>`; }).join('');
}

/* ----- localização ----- */
function salvarGeo(cod) {
  if (!navigator.geolocation) { alert('Este aparelho não oferece localização.'); return; }
  toast('Obtendo localização…');
  navigator.geolocation.getCurrentPosition(async (pos) => {
    cod = normCod(cod);
    const info = S.pdvInfo.find((x) => x.id === cod) || { id: cod };
    Object.assign(info, { lat: +pos.coords.latitude.toFixed(6), lng: +pos.coords.longitude.toFixed(6), acc: pos.coords.accuracy, geoEm: new Date().toISOString() });
    await save('pdvInfo', info);
    toast(pos.coords.accuracy > 100 ? `Local salvo, mas com baixa precisão (±${Math.round(pos.coords.accuracy)} m). Tente atualizar ao ar livre.` : 'Localização do PDV salva 📍');
    if (dlg.open) dlgHandlers.refresh?.(); else render();
  }, (err) => {
    alert(err.code === 1 ? 'Permita o acesso à localização para este app nas configurações do navegador.' : 'Não foi possível obter a localização. Tente de novo (de preferência ao ar livre).');
  }, { enableHighAccuracy: true, timeout: 25000, maximumAge: 0 });
}

/* ----- detalhe do PDV ----- */
function openPdvDetail(cod) {
  cod = normCod(cod);
  const c = cliente(cod);
  const vs = S.visitas.filter((v) => v.codigo === cod).sort((a, b) => (b.data + b.hora).localeCompare(a.data + a.hora));
  const nome = nomeCli(c) || vs[0]?.nome || S.pendencias.find((p) => p.codigo === cod)?.nomePdv || cod;
  const kv = c ? [
    ['Código', c.id], ['Razão social', c.razao], ['Documento', c.documento], ['Endereço', [c.endereco, c.complemento].filter(Boolean).join(' - ')],
    ['Bairro / Cidade', `${c.bairro} · ${c.cidade}/${c.uf}`], ['Telefone', c.telefone], ['Categoria', c.categoria], ['Segmento', c.segmento],
    ['Setor VDE', `${c.setor}${c.diaVisita ? ' · visita ' + c.diaVisita : ''}${c.proxVisita ? ' · próx. ' + c.proxVisita : ''}`],
    ['Última compra', c.ultimaCompra], ['Fat. mês', c.fatMes], ['Média 3 meses', c.media3m], ['Comodato', c.comodato],
    ['Limite disponível', c.limiteDisp], ['Títulos pendentes', c.titulosPend],
  ].filter(([, x]) => x && String(x).trim()) : [['Código', cod], ['Base', 'PDV fora da base de clientes ativos']];
  openDialog(`<div class="vhead"><h2>${esc(nome)}</h2></div>
    <div id="v-geo">${geoBlock(cod)}</div>
    <div class="kv">${kv.map(([k, x]) => `<span class="muted">${k}</span><span>${esc(x)}</span>`).join('')}</div>
    <fieldset class="ckset"><legend>Pendências</legend><div id="v-pend">${pendBlock(cod)}</div></fieldset>
    <fieldset class="ckset"><legend>Visitas (${vs.length})</legend>
      ${vs.length ? `<div class="checks">${vs.slice(0, 15).map((v) => `<div class="check"><span class="txt"><b>${DIAS[dow(v.data)]} ${fmtBR(v.data)} · ${esc(TIPOS[v.tipo])}${v.colabId ? ' · ' + esc(colabNome(v.colabId)) : ''}</b><small>${v.fotos?.length ? `📷${v.fotos.length} · ` : ''}${esc(v.obs || '')}</small></span><span class="pct ${pctClass(execPct(v.itens), v.tipo)}">${pctTxt(execPct(v.itens))}</span></div>`).join('')}</div>` : '<span class="hint">Nenhuma visita registrada.</span>'}
    </fieldset>
    <div class="dlg-actions"><span class="sp"></span><button type="button" class="primary" data-act="close">Fechar</button></div>`, {
    onSubmit() { return false; },
    refresh() { const p = $('#v-pend'); if (p) p.innerHTML = pendBlock(cod); const g = $('#v-geo'); if (g) g.innerHTML = geoBlock(cod); },
    onClose: render,
  });
}

/* =========================================================================
   MINHA AGENDA
   ========================================================================= */
function weekNav(extra = '') {
  const w = ui.week;
  return `<div class="toolbar">
    <div class="weeknav">
      <button class="icon" data-act="wk" data-d="-7" aria-label="Semana anterior">‹</button>
      <div class="wklabel"><b>${fmtBR(w)} – ${fmtBR(addDays(w, 5))}</b><small>${mesAno(w)}</small></div>
      <button class="icon" data-act="wk" data-d="7" aria-label="Próxima semana">›</button>
    </div>
    <div class="tb-actions"><button class="ghost" data-act="wk-today">Hoje</button>${extra}</div>
  </div>`;
}

function viewAgenda() {
  const w = ui.week, fim = addDays(w, 6);
  const ents = S.agenda.filter((a) => a.data >= w && a.data <= fim);
  const days = DIAS_SEMANA.map((i) => addDays(w, i - 1));
  return weekNav(`<button class="ghost" data-act="copy-week">Copiar semana anterior</button><button class="primary" data-act="new-entry" data-date="${today() >= w && today() <= fim ? today() : w}">+ Novo</button>`)
    + resumoSemana(ents)
    + `<div class="week">${days.map((d) => dayCard(d, ents.filter((a) => a.data === d))).join('')}</div>`;
}

function resumoSemana(ents) {
  const st = (id) => {
    const mine = ents.filter((a) => a.colabId === id && (a.tipo === 'RN' || a.tipo === 'PROM'));
    if (mine.some((a) => a.status === 'ok')) return 'done';
    if (mine.some((a) => a.status === 'plan' || a.status === 'reag')) return 'plan';
    return '';
  };
  const linha = (titulo, lista) => {
    const feitos = lista.filter((c) => st(c.id) === 'done').length;
    const plan = lista.filter((c) => st(c.id)).length;
    return `<div class="row"><span class="lbl">${titulo} <small>${feitos}/${lista.length}</small></span>
      ${lista.map((c) => `<span class="pill ${st(c.id)}">${esc(c.nome)}</span>`).join('')}
      ${plan > feitos ? `<span class="legend">· ${plan - feitos} planejado(s)</span>` : ''}</div>`;
  };
  const turnos = (t) => ents.filter((a) => a.tipo === t && a.status !== 'nao').reduce((n, a) => n + (a.turno === 'D' ? 2 : 1), 0);
  return `<section class="resumo" aria-label="Resumo da semana">
    ${linha('RNs', colabs('RN'))}
    ${linha('Promotores', colabs('PROM'))}
    <div class="row legend">Turnos: ${turnos('RN')} com RN · ${turnos('PROM')} com promotor · ${turnos('IND')} independente · ${turnos('INT')} interno
      &nbsp;|&nbsp; <span class="pill done">verde</span> = acompanhado &nbsp;<span class="pill plan">tracejado</span> = só planejado</div>
  </section>`;
}

function dayCard(d, list) {
  const isToday = d === today();
  const dia = list.filter((a) => a.turno === 'D');
  const slot = (t) => {
    const items = list.filter((a) => a.turno === t);
    const empty = !items.length && !dia.length;
    return `<div class="slot"><span class="slot-lbl">${TURNOS[t]}</span>
      ${items.map(entryChip).join('')}
      ${empty ? `<button class="add-slot" data-act="new-entry" data-date="${d}" data-turno="${t}">+ ${TURNOS[t]}</button>` : ''}</div>`;
  };
  return `<section class="day ${isToday ? 'today' : ''}">
    <header><b>${DIAS[dow(d)]}</b><small>${fmtBR(d)}</small>${isToday ? '<span class="tag">hoje</span>' : ''}</header>
    ${dia.length ? `<div class="slot"><span class="slot-lbl">Dia todo</span>${dia.map(entryChip).join('')}</div>` : ''}
    ${slot('M')}${slot('T')}
  </section>`;
}

function entryChip(a) {
  let l2 = [...(a.focos || []), a.focoTxt].filter(Boolean).join(' · ');
  if (a.tipo === 'INT' && a.motivoTxt) l2 = [a.motivoTxt, l2].filter(Boolean).join(' · ');
  if (a.tipo !== 'INT' && a.rota) l2 = [a.rota, l2].filter(Boolean).join(' · ');
  const nv = S.visitas.filter((v) => v.agendaId === a.id).length;
  if (nv) l2 = `${nv} visitado(s) · ${l2}`;
  else if (a.tipo === 'PROM') { const n = pdvsDoDia(a.colabId, a.data).length; if (n) l2 = `${n} PDVs · ${l2}`; }
  return `<button class="entry t-${a.tipo} st-${a.status}" data-act="edit-entry" data-id="${a.id}">
    <span class="l1"><span class="badge">${TIPO_CURTO[a.tipo]}</span><span class="who">${esc(whoEntry(a))}</span><span class="st ${a.status}">${STATUS_ICO[a.status]}</span></span>
    ${l2 ? `<span class="l2">${esc(l2)}</span>` : ''}
  </button>`;
}

function entryDyn(v) {
  if (v.tipo === 'INT') {
    return `<label>Motivo<select name="motivo" required>${options(cfg().motivos.map((m) => ({ v: m, t: m })), v.motivo, 'Escolha o motivo…')}</select></label>
      <label>Detalhe do motivo<input name="motivoTxt" value="${esc(v.motivoTxt)}" placeholder="Opcional"></label>`;
  }
  if (v.tipo === 'IND') {
    return `<label>Rota / Região<input name="rota" value="${esc(v.rota)}" placeholder="Ex.: Conde / Jacumã"></label>
      <span class="hint">Rota sozinho: escolha um foco claro abaixo (obrigatório).</span>`;
  }
  const lista = colabs(v.tipo);
  let html = `<div class="row2">
    <label>${v.tipo === 'RN' ? 'RN' : 'Promotor'}<select name="colabId" required>${options(lista.map((c) => ({ v: c.id, t: c.nome })), v.colabId, 'Escolha…')}</select></label>
    <label>Rota / Setor<input name="rota" value="${esc(v.rota)}" placeholder="Opcional"></label></div>`;
  if (v.tipo === 'PROM' && v.colabId && v.data) {
    const ps = pdvsDoDia(v.colabId, v.data);
    html += `<div class="preview"><b style="font-size:13px">Roteiro do promotor em ${DIAS[dow(v.data)]} ${fmtBR(v.data)}: ${ps.length} PDV(s)</b>
      ${ps.length ? `<ul class="pdvlist">${ps.map((p) => `<li><code>${esc(p.codigo)}</code>${esc(p.nome)}</li>`).join('')}</ul>` : '<span class="hint">Nenhum PDV na base para este dia.</span>'}</div>`;
  }
  return html;
}

function readEntry(f) {
  const fd = new FormData(f);
  return {
    data: fd.get('data'), turno: fd.get('turno'), tipo: fd.get('tipo'),
    colabId: fd.get('colabId') || '', rota: (fd.get('rota') || '').trim(),
    motivo: fd.get('motivo') || '', motivoTxt: (fd.get('motivoTxt') || '').trim(),
    focos: fd.getAll('focos'), focoTxt: (fd.get('focoTxt') || '').trim(),
    status: fd.get('status') || 'plan', obs: (fd.get('obs') || '').trim(),
  };
}

function openEntry(a, opts = {}) {
  const v = Object.assign({ data: today(), turno: 'M', tipo: 'RN', status: 'plan', focos: [] }, a);
  const html = `<h2>${v.id ? 'Editar compromisso' : 'Novo compromisso'}</h2>
    ${v.id ? `<a class="sm-link" href="#/dia/${v.id}" data-act="close">▶ Abrir execução (visitas, pendências, planos)</a>` : ''}
    <label>Data<input type="date" name="data" value="${v.data}" required></label>
    <fieldset class="seg"><legend>Turno</legend>${radios('turno', TURNOS, v.turno)}</fieldset>
    <fieldset class="seg"><legend>Com quem / onde</legend>${radios('tipo', TIPOS, v.tipo)}</fieldset>
    <div id="f-dyn" style="display:grid;gap:12px">${entryDyn(v)}</div>
    <fieldset><legend>Foco do turno</legend>
      <div class="chips">${cfg().focos.map((f) => `<label><input type="checkbox" name="focos" value="${esc(f)}" ${v.focos?.includes(f) ? 'checked' : ''}><span>${esc(f)}</span></label>`).join('')}</div>
      <input name="focoTxt" value="${esc(v.focoTxt)}" placeholder="Detalhe do foco (opcional)">
    </fieldset>
    <fieldset class="seg"><legend>Status</legend>${radios('status', STATUS, v.status)}</fieldset>
    <label>Observações<textarea name="obs" rows="3">${esc(v.obs)}</textarea></label>
    <div class="err" id="f-err"></div>
    <div class="dlg-actions">
      ${v.id ? '<button type="button" class="danger" data-act="del-entry">Excluir</button>' : ''}
      ${v.id ? '<button type="button" class="ghost" data-act="dup-entry">Duplicar</button>' : ''}
      <span class="sp"></span>
      <button type="button" class="ghost" data-act="close">Cancelar</button>
      <button class="primary">Salvar</button>
    </div>`;
  openDialog(html, {
    onChange(f, e) {
      if (['tipo', 'data', 'colabId'].includes(e.target.name)) {
        const cur = readEntry(f);
        if (e.target.name === 'tipo') cur.colabId = '';
        $('#f-dyn', f).innerHTML = entryDyn(cur);
      }
    },
    async onSubmit(f) {
      const n = readEntry(f);
      const err = $('#f-err', f);
      if (!n.data) { err.textContent = 'Informe a data.'; return false; }
      if ((n.tipo === 'RN' || n.tipo === 'PROM') && !n.colabId) { err.textContent = 'Escolha o colaborador.'; return false; }
      if (n.tipo === 'INT' && !n.motivo) { err.textContent = 'Escolha o motivo do dia interno.'; return false; }
      if (n.tipo === 'IND' && !n.focos.length && !n.focoTxt) { err.textContent = 'Rota independente precisa de um foco.'; return false; }
      if (n.tipo === 'INT') { n.colabId = ''; n.rota = ''; } else { n.motivo = ''; n.motivoTxt = ''; }
      if (n.tipo === 'IND') n.colabId = '';
      const obj = Object.assign({}, a?.id ? S.agenda.find((x) => x.id === a.id) : {}, { id: v.id || uid(), criado: v.criado || new Date().toISOString() }, n);
      await save('agenda', obj);
      if (n.data < ui.week || n.data > addDays(ui.week, 6)) ui.week = monday(n.data);
      toast('Compromisso salvo');
      if (opts.go) { closeDialog(); location.hash = `#/dia/${obj.id}`; return false; }
    },
    actions: {
      'del-entry': async () => {
        const nv = S.visitas.filter((x) => x.agendaId === v.id).length;
        if (!confirm(`Excluir este compromisso?${nv ? ` As ${nv} visita(s) registradas nele também serão excluídas.` : ''}`)) return;
        for (const x of S.visitas.filter((x) => x.agendaId === v.id)) { for (const fid of x.fotos || []) await dbDel('fotos', fid); await remove('visitas', x.id); }
        await remove('agenda', v.id); closeDialog();
        if (route().name === 'dia') location.hash = '#/hoje'; else render();
        toast('Compromisso excluído');
      },
      'dup-entry': () => { const cur = readEntry(dform); closeDialog(); openEntry(Object.assign(cur, { status: 'plan' })); },
    },
  });
}

async function copyWeek() {
  const src = addDays(ui.week, -7);
  const prev = S.agenda.filter((a) => a.data >= src && a.data <= addDays(src, 6));
  if (!prev.length) { toast('A semana anterior está vazia'); return; }
  const ocupado = new Set(S.agenda.filter((a) => a.data >= ui.week && a.data <= addDays(ui.week, 6)).map((a) => `${a.data}|${a.turno}`));
  const novos = prev.filter((a) => !ocupado.has(`${addDays(a.data, 7)}|${a.turno}`));
  if (!novos.length) { toast('Os turnos desta semana já estão preenchidos'); return; }
  if (!confirm(`Copiar ${novos.length} compromisso(s) da semana anterior como "Planejado"? Turnos já preenchidos nesta semana não são alterados.`)) return;
  for (const a of novos) {
    const { inicio, fim, notas, ...rest } = a;
    await save('agenda', Object.assign({}, rest, { id: uid(), data: addDays(a.data, 7), status: 'plan', obs: '', criado: new Date().toISOString() }));
  }
  render(); toast(`${novos.length} compromisso(s) copiado(s)`);
}

/* =========================================================================
   PENDÊNCIAS E PLANOS DE AÇÃO
   ========================================================================= */
function viewPendencias() {
  const tabs = `<div class="tabs" role="tablist">
    <button class="${ui.pendTab === 'pend' ? 'on' : ''}" data-act="pend-tab" data-tab="pend">Pendências de PDV (${S.pendencias.filter((p) => !p.resolvida).length})</button>
    <button class="${ui.pendTab === 'planos' ? 'on' : ''}" data-act="pend-tab" data-tab="planos">Planos de ação (${S.planos.filter((p) => !p.feito).length})</button></div>`;
  const filtro = `<div class="toolbar">
    <input class="search" type="search" placeholder="Buscar…" value="${esc(ui.pendBusca)}" data-input="pendBusca">
    <div class="tabs" style="margin:0">${['abertas', 'resolvidas', 'todas'].map((f) => `<button class="${ui.pendFiltro === f ? 'on' : ''}" data-act="pend-filtro" data-f="${f}">${f[0].toUpperCase() + f.slice(1)}</button>`).join('')}</div></div>`;
  const q = norm(ui.pendBusca);
  if (ui.pendTab === 'planos') {
    const list = S.planos.filter((p) => (ui.pendFiltro === 'todas' || (ui.pendFiltro === 'abertas') !== !!p.feito) && (!q || norm(`${p.acao} ${p.resp} ${p.origem}`).includes(q))).sort(planoSort);
    return tabs + filtro + `<div class="addplano card">
        <input id="pa-acao" placeholder="Novo plano de ação"><input id="pa-resp" placeholder="Responsável"><input id="pa-prazo" type="date" aria-label="Prazo">
        <button data-act="plano-add">Adicionar</button></div>`
      + (list.length ? `<div class="checks card">${list.map(planoItem).join('')}</div>` : '<div class="empty">Nada por aqui.</div>');
  }
  const list = S.pendencias.filter((p) => (ui.pendFiltro === 'todas' || (ui.pendFiltro === 'abertas') !== !!p.resolvida) && (!q || norm(`${p.descricao} ${p.nomePdv} ${p.codigo}`).includes(q)))
    .sort((a, b) => a.resolvida - b.resolvida || (b.criada || '').localeCompare(a.criada || ''));
  return tabs + filtro + `<p class="hint">Pendências nascem durante as visitas. Marque a caixa quando resolver.</p>`
    + (list.length ? `<div class="checks card">${list.map((p) => pendItem(p, true)).join('')}</div>` : '<div class="empty">Nada por aqui.</div>');
}

/* =========================================================================
   PROMOTORES — agenda + base de PDVs
   ========================================================================= */
function viewPromotores() {
  const proms = colabs('PROM');
  if (!proms.length) return `<div class="empty">Nenhum promotor ativo. Cadastre em <a href="#/cadastros">Cadastros</a>.</div>`;
  if (!proms.some((p) => p.id === ui.promId)) ui.promId = proms[0].id;
  const tabs = `<div class="tabs" role="tablist">
    <button class="${ui.promTab === 'agenda' ? 'on' : ''}" data-act="prom-tab" data-tab="agenda">Agenda da semana</button>
    <button class="${ui.promTab === 'base' ? 'on' : ''}" data-act="prom-tab" data-tab="base">Base de PDVs</button></div>`;
  const chips = `<div class="chiprow">${proms.map((p) => {
    const n = S.pdvs.filter((x) => x.promotorId === p.id && x.ativo !== false).length;
    return `<button class="${p.id === ui.promId ? 'on' : ''}" data-act="prom-sel" data-id="${p.id}">${esc(p.nome)} <small>· ${n} PDVs</small></button>`;
  }).join('')}</div>`;
  return tabs + chips + (ui.promTab === 'agenda' ? promAgenda() : promBase());
}

function promAgenda() {
  const w = ui.week, id = ui.promId;
  const days = DIAS_SEMANA.map((i) => addDays(w, i - 1));
  const total = days.reduce((n, d) => n + pdvsDoDia(id, d).length, 0);
  const meus = S.agenda.filter((a) => a.tipo === 'PROM' && a.colabId === id && a.data >= w && a.data <= addDays(w, 6));
  return weekNav(`<button class="ghost" data-act="prom-tab" data-tab="base">Editar base</button>`)
    + `<p class="count">${total} visita(s) programada(s) na semana para ${esc(colabNome(id))}.</p>`
    + `<div class="week">${days.map((d) => {
      const ps = pdvsDoDia(id, d);
      const eu = meus.filter((a) => a.data === d);
      return `<section class="day ${d === today() ? 'today' : ''}">
        <header><b>${DIAS[dow(d)]}</b><small>${fmtBR(d)}</small><span class="count" style="margin-left:auto">${ps.length} PDV(s)</span></header>
        ${eu.length ? `<span class="pill done" style="width:fit-content">Você acompanha (${eu.map((a) => TURNOS[a.turno]).join(', ')})</span>` : ''}
        ${ps.length ? `<ul class="pdvlist">${ps.map((p) => `<li><code>${esc(p.codigo)}</code>${esc(p.nome)}</li>`).join('')}</ul>` : '<span class="hint">Sem visitas</span>'}
        <button class="add-slot sm" data-act="new-entry" data-date="${d}" data-tipo="PROM" data-colab="${id}">+ Acompanhar neste dia</button>
      </section>`;
    }).join('')}</div>`;
}

function promBase() {
  const id = ui.promId, q = norm(ui.busca);
  const list = S.pdvs.filter((p) => p.promotorId === id && (!q || norm(`${p.codigo} ${p.nome} ${p.bairro}`).includes(q)))
    .sort((a, b) => (a.ativo === false) - (b.ativo === false) || a.nome.localeCompare(b.nome));
  return `<div class="toolbar">
      <input class="search" type="search" placeholder="Buscar código, nome ou bairro" value="${esc(ui.busca)}" data-input="busca">
      <div class="tb-actions"><button class="ghost" data-act="pdv-bulk">Colar lista</button><button class="primary" data-act="pdv-new">+ PDV</button></div>
    </div>
    ${list.length ? `<div class="list">${list.map((p) => `<button class="item ${p.ativo === false ? 'off' : ''}" data-act="pdv-edit" data-id="${p.id}">
        <span class="main"><b>${esc(p.nome)}</b><small>${esc(p.codigo)}${p.bairro ? ' · ' + esc(p.bairro) : ''}${p.ativo === false ? ' · inativo' : ''}</small></span>
        <span style="display:grid;justify-items:end;gap:4px"><span class="days">${DIAS_SEMANA.map((d) => `<span class="${p.dias?.includes(d) ? 'on' : ''}">${DIAS[d]}</span>`).join('')}</span>
        <small>${PERIODOS[p.cadaSemanas] || 'Semanal'}</small></span>
      </button>`).join('')}</div>`
    : `<div class="empty">${q ? 'Nada encontrado.' : 'Nenhum PDV na base deste promotor ainda.<br>Use <b>+ PDV</b> ou <b>Colar lista</b> (copie código e nome do Excel).'}</div>`}`;
}

function pdvForm(p) {
  const v = Object.assign({ promotorId: ui.promId, dias: [], cadaSemanas: 1, inicio: monday(today()), ativo: true }, p);
  return `<h2>${v.id ? 'Editar PDV' : 'Novo PDV na base'}</h2>
    <div class="row2"><label>Código do PDV<input name="codigo" value="${esc(v.codigo)}" inputmode="numeric" autofocus></label>
    <label>Promotor<select name="promotorId">${options(colabs('PROM', true).map((c) => ({ v: c.id, t: c.nome })), v.promotorId)}</select></label></div>
    <label>Nome do PDV<input name="nome" value="${esc(v.nome)}" required></label>
    <label>Bairro / Endereço<input name="bairro" value="${esc(v.bairro)}" placeholder="Opcional"></label>
    <span class="hint" id="f-cli"></span>
    <fieldset><legend>Dias de visita</legend>${daysPicker(v.dias)}</fieldset>
    <fieldset class="seg"><legend>Periodicidade</legend>${radios('cadaSemanas', PERIODOS, v.cadaSemanas)}</fieldset>
    <label id="f-ini" ${Number(v.cadaSemanas) > 1 ? '' : 'hidden'}>Semana de referência (1ª visita)<input type="date" name="inicio" value="${esc(v.inicio)}">
      <span class="hint">A partir desta semana, o PDV entra no roteiro a cada ${Number(v.cadaSemanas) || 2} semanas.</span></label>
    <label style="display:flex;gap:8px;align-items:center;color:var(--text)"><input type="checkbox" name="ativo" ${v.ativo !== false ? 'checked' : ''}> PDV ativo no roteiro</label>
    <label>Observações<textarea name="obs" rows="2">${esc(v.obs)}</textarea></label>
    <div class="err" id="f-err"></div>
    <div class="dlg-actions">${v.id ? '<button type="button" class="danger" data-act="pdv-del">Excluir</button>' : ''}<span class="sp"></span>
      <button type="button" class="ghost" data-act="close">Cancelar</button><button class="primary">Salvar</button></div>`;
}
function onPeriodChange(f, e) {
  if (e.target.name === 'codigo') {
    const c = cliente(e.target.value);
    const nome = f.querySelector('[name="nome"]'), bairro = f.querySelector('[name="bairro"]');
    if (c) {
      if (!nome.value.trim()) nome.value = nomeCli(c);
      if (bairro && !bairro.value.trim()) bairro.value = `${c.bairro} · ${c.cidade}`;
      $('#f-cli', f).textContent = `✓ Encontrado na base: ${nomeCli(c)} (${c.categoria})`;
    } else if ($('#f-cli', f)) $('#f-cli', f).textContent = S.clientes.length ? 'Código não está na base de clientes ativos.' : '';
  }
  if (e.target.name !== 'cadaSemanas') return;
  const n = Number(e.target.value), box = $('#f-ini', f);
  box.hidden = n === 1;
  box.querySelector('.hint').textContent = `A partir desta semana, o PDV entra no roteiro a cada ${n} semanas.`;
}
function openPdv(p) {
  openDialog(pdvForm(p), {
    onChange: onPeriodChange,
    async onSubmit(f) {
      const fd = new FormData(f), err = $('#f-err', f);
      const n = {
        codigo: normCod(fd.get('codigo')), nome: (fd.get('nome') || '').trim(), bairro: (fd.get('bairro') || '').trim(),
        promotorId: fd.get('promotorId'), dias: fd.getAll('dias').map(Number), cadaSemanas: Number(fd.get('cadaSemanas')) || 1,
        inicio: fd.get('inicio') || monday(today()), ativo: fd.get('ativo') === 'on', obs: (fd.get('obs') || '').trim(),
      };
      if (!n.nome) { err.textContent = 'Informe o nome do PDV.'; return false; }
      if (!n.dias.length) { err.textContent = 'Marque pelo menos um dia de visita.'; return false; }
      const dup = n.codigo && S.pdvs.find((x) => normCod(x.codigo) === n.codigo && x.promotorId === n.promotorId && x.id !== p?.id);
      if (dup) { err.textContent = `O código ${n.codigo} já está na base deste promotor (${dup.nome}).`; return false; }
      await save('pdvs', Object.assign({ id: p?.id || uid(), criado: p?.criado || new Date().toISOString() }, n));
      toast('PDV salvo');
    },
    actions: {
      'pdv-del': async () => {
        if (!confirm(`Excluir ${p.nome} da base? (Para pausar sem apagar, desmarque "PDV ativo".)`)) return;
        await remove('pdvs', p.id); closeDialog(); render(); toast('PDV excluído');
      },
    },
  });
}

function openBulk() {
  const html = `<h2>Colar lista de PDVs</h2>
    <p class="hint" style="margin:0">Uma linha por PDV: <b>código</b> e <b>nome</b> separados por TAB (copiado do Excel), ponto e vírgula ou traço. Também pode colar <b>só os códigos</b> — o nome vem da base de clientes. Os dias e a periodicidade abaixo valem para todos.</p>
    <textarea name="lista" rows="8" placeholder="20357	SQUINA MAR ACAU&#10;20002&#10;7008" autofocus></textarea>
    <label>Promotor<select name="promotorId">${options(colabs('PROM').map((c) => ({ v: c.id, t: c.nome })), ui.promId)}</select></label>
    <fieldset><legend>Dias de visita</legend>${daysPicker([])}</fieldset>
    <fieldset class="seg"><legend>Periodicidade</legend>${radios('cadaSemanas', PERIODOS, 1)}</fieldset>
    <label id="f-ini" hidden>Semana de referência (1ª visita)<input type="date" name="inicio" value="${monday(today())}"><span class="hint"></span></label>
    <div class="err" id="f-err"></div>
    <div class="dlg-actions"><span class="sp"></span><button type="button" class="ghost" data-act="close">Cancelar</button><button class="primary">Importar</button></div>`;
  openDialog(html, {
    onChange: onPeriodChange,
    async onSubmit(f) {
      const fd = new FormData(f), err = $('#f-err', f);
      const dias = fd.getAll('dias').map(Number);
      const promotorId = fd.get('promotorId');
      if (!dias.length) { err.textContent = 'Marque os dias de visita.'; return false; }
      const linhas = String(fd.get('lista') || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
      let novos = 0, pulados = 0;
      for (const l of linhas) {
        const m = l.match(/^\s*([^\t;]+?)\s*(?:\t|;|\s-\s)\s*(.+)$/);
        let codigo = m ? normCod(m[1]) : '', nome = m ? m[2].trim() : l;
        if (!m && /^\d+$/.test(l)) { codigo = normCod(l); nome = nomeCli(cliente(codigo)) || codigo; }
        const c = cliente(codigo);
        if (codigo && S.pdvs.some((x) => normCod(x.codigo) === codigo && x.promotorId === promotorId)) { pulados++; continue; }
        await save('pdvs', { id: uid(), codigo, nome, bairro: c ? `${c.bairro} · ${c.cidade}` : '', promotorId, dias, cadaSemanas: Number(fd.get('cadaSemanas')) || 1, inicio: fd.get('inicio') || monday(today()), ativo: true, obs: '', criado: new Date().toISOString() });
        novos++;
      }
      if (!novos && !pulados) { err.textContent = 'Cole pelo menos uma linha.'; return false; }
      ui.promId = promotorId;
      toast(`${novos} PDV(s) importado(s)${pulados ? `, ${pulados} já existiam` : ''}`);
    },
  });
}

/* =========================================================================
   BASE DE CLIENTES — importação do CSV do sistema
   ========================================================================= */
const COLS = {
  id: 'cod pdv', documento: 'documento', fantasia: 'nome fantasia', razao: 'razao social', endereco: 'endereco', complemento: 'complemento',
  bairro: 'bairro', cidade: 'cidade', uf: 'uf', cep: 'cep', telefone: 'telefone(s)', categoria: 'categoria', segmento: 'segmento nge',
  setor: 'setor vde', diaVisita: 'dia de visita do vde', proxVisita: 'data da prox visita vde', ultimaCompra: 'data da ultima compra',
  comodato: 'possui comodato', limiteDisp: 'limite de credito disponivel', titulosPend: 'titulos pendentes', fatMes: 'faturamento total (mes)',
  media3m: 'media faturamento(3 meses)', status: 'status do pdv',
};
function parseCSV(text, sep) {
  const rows = []; let row = [], f = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; }
    else if (c === '"') q = true;
    else if (c === sep) { row.push(f); f = ''; }
    else if (c === '\n') { row.push(f); rows.push(row); row = []; f = ''; }
    else if (c !== '\r') f += c;
  }
  if (f || row.length) { row.push(f); rows.push(row); }
  return rows;
}
async function importBase(file) {
  const buf = await file.arrayBuffer();
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch { text = new TextDecoder('windows-1252').decode(buf); }
  const first = text.slice(0, text.indexOf('\n'));
  const rows = parseCSV(text, first.split(';').length >= first.split(',').length ? ';' : ',');
  const head = rows.shift().map((h) => norm(h));
  const idx = Object.fromEntries(Object.entries(COLS).map(([k, h]) => [k, head.indexOf(h)]));
  if (idx.id < 0 || idx.status < 0) { alert('Arquivo não reconhecido: não encontrei as colunas "Cód PDV" e "Status do PDV".'); return; }
  const ativos = [];
  for (const r of rows) {
    if (r.length < head.length / 2) continue;
    if (norm(r[idx.status]) !== 'ativo') continue;
    const o = {};
    for (const [k, i] of Object.entries(idx)) o[k] = i >= 0 ? String(r[i] ?? '').trim() : '';
    o.id = normCod(o.id); if (!o.id) continue;
    delete o.status;
    ativos.push(o);
  }
  if (!ativos.length) { alert('Nenhum cliente com status "Ativo" encontrado no arquivo.'); return; }
  if (!confirm(`Importar ${ativos.length} clientes ativos (de ${rows.filter((r) => r.length > 1).length} no arquivo)?\nA base anterior será substituída. Localizações, pendências e visitas que você registrou NÃO são apagadas.`)) return;
  await dbClear('clientes');
  await dbPutMany('clientes', ativos);
  S.clientes = ativos; buildIndex();
  S.config.baseImportada = { em: new Date().toISOString(), arquivo: file.name, ativos: ativos.length };
  await saveConfig();
  render(); toast(`${ativos.length} clientes ativos importados`);
}

/* =========================================================================
   CADASTROS + DADOS
   ========================================================================= */
function viewCadastros() {
  const lista = (tipo, titulo) => `<section class="card">
    <header><h3>${titulo}</h3><button class="sm" data-act="colab-new" data-tipo="${tipo}">+ Adicionar</button></header>
    <div class="list">${colabs(tipo, true).map((c) => `<button class="item ${c.ativo === false ? 'off' : ''}" data-act="colab-edit" data-id="${c.id}">
      <span class="main"><b>${esc(c.nome)}</b><small>${c.setor ? 'Setor VDE ' + esc(c.setor) : tipo === 'RN' ? 'sem setor' : ''}${c.ativo === false ? ' · inativo' : ''}</small></span><small>Editar</small></button>`).join('') || '<div class="empty">Ninguém cadastrado</div>'}</div>
  </section>`;
  const listaTxt = (key, titulo, hint) => `<section class="card">
    <header><h3>${titulo}</h3></header>
    <span class="hint">${hint}</span>
    <textarea rows="7" data-list="${key}">${esc(cfg()[key].join('\n'))}</textarea>
    <button class="sm" data-act="save-list" data-key="${key}" style="justify-self:start">Salvar lista</button>
  </section>`;
  const ub = cfg().ultimoBackup, bi = cfg().baseImportada;
  const q = ui.baseBusca.trim();
  const res = q ? buscaClientes(q, 30) : [];
  return `<div class="grid2">
    <section class="card">
      <header><h3>Base de clientes</h3></header>
      <div class="kv"><span class="muted">Clientes ativos</span><b>${S.clientes.length}</b>
        <span class="muted">Importada em</span><b>${bi ? new Date(bi.em).toLocaleString('pt-BR') : 'nunca'}</b>
        ${bi ? `<span class="muted">Arquivo</span><span>${esc(bi.arquivo)}</span>` : ''}
        <span class="muted">PDVs com local salvo</span><b>${S.pdvInfo.filter((x) => x.lat != null).length}</b></div>
      <span class="hint">Importe o CSV "BASE DE CLIENTES" exportado do sistema. Só os PDVs com status <b>Ativo</b> entram. Reimportar atualiza a base sem perder suas localizações, pendências e visitas.</span>
      <div><button class="primary" data-act="base-import">Importar CSV da base</button><input type="file" id="basefile" accept=".csv,text/csv" hidden></div>
      ${S.clientes.length ? `<input type="search" placeholder="Consultar cliente: código, nome, bairro…" value="${esc(ui.baseBusca)}" data-input="baseBusca">
        ${res.length ? `<div class="list">${res.map((c) => `<button class="item" data-act="pdv-detail" data-cod="${esc(c.id)}"><span class="main"><b>${esc(nomeCli(c))}</b><small>${esc(c.id)} · ${esc(c.bairro)} · ${esc(c.cidade)} · setor ${esc(c.setor)}</small></span><span class="icons">${pendAbertas(c.id).length ? '⚠️' : ''}${geo(c.id) ? '📍' : ''}</span></button>`).join('')}</div>` : q ? '<span class="hint">Nada encontrado.</span>' : ''}` : ''}
    </section>
    ${lista('RN', 'RNs')}
    ${lista('PROM', 'Promotores')}
    <section class="card">
      <header><h3>Regras de execução</h3></header>
      <div class="row2">
        <label>% mínimo p/ "Executado" (RN e independente)<input type="number" min="0" max="100" data-cfg="minExec" value="${esc(cfg().minExec)}"></label>
        <label>Dia com RN conta com mais de (PDVs)<input type="number" min="0" data-cfg="minPdvsRN" value="${esc(cfg().minPdvsRN)}"></label>
      </div>
      <span class="hint">Promotor: "Executado" só com 100% (todos os itens aplicáveis com Sim). % = itens Sim ÷ itens aplicáveis (N/A sai da conta).</span>
    </section>
    ${listaTxt('checkRN', 'Check list de execução — RN / independente', 'Um item por linha. Mudou o trimestre? Ajuste aqui. Visitas antigas mantêm os itens da época.')}
    ${listaTxt('checkPROM', 'Check list — Promotor', 'Um item por linha. Em "Sem Ruptura", responda Sim quando NÃO houver ruptura.')}
    ${listaTxt('tiposCT', 'Tipos de CT (Possível CT)', 'Um por linha.')}
    ${listaTxt('focos', 'Focos do dia/turno', 'Um por linha. Aparecem como opções ao criar um compromisso.')}
    ${listaTxt('motivos', 'Motivos de dia interno', 'Um por linha. Ex.: reunião de quarta, relatórios…')}
    <section class="card">
      <header><h3>Exportar para planilha</h3></header>
      <span class="hint">Arquivos CSV no mesmo esquema da planilha "Agenda Rota" — abrem direto no Excel.</span>
      <div class="row2"><label>De<input type="date" id="ex-de" value="${monday(today())}"></label><label>Até<input type="date" id="ex-ate" value="${today()}"></label></div>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <button data-act="csv-rn">Visitas RN / independente</button>
        <button data-act="csv-prom">Visitas promotores</button>
        <button data-act="csv-pend">Pendências</button>
        <button data-act="csv-planos">Planos de ação</button>
      </div>
    </section>
    <section class="card">
      <header><h3>Backup</h3></header>
      <div class="kv">
        <span class="muted">Compromissos</span><b>${S.agenda.length}</b>
        <span class="muted">Visitas</span><b>${S.visitas.length}</b>
        <span class="muted">Pendências</span><b>${S.pendencias.length}</b>
        <span class="muted">Último backup</span><b>${ub ? new Date(ub).toLocaleString('pt-BR') : 'nunca'}</b>
        <span class="muted">Armazenamento</span><b id="persist">verificando…</b>
      </div>
      <span class="hint">Os dados ficam só neste aparelho. Faça backup com frequência e guarde o arquivo (Drive, e-mail…). Para passar do PC para o celular (inclusive a base de clientes), exporte num e importe no outro.</span>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <button class="primary" data-act="export">Exportar backup</button>
        <button data-act="export-fotos">Backup com fotos</button>
        <button data-act="import">Importar backup</button>
        <input type="file" id="importfile" accept="application/json,.json" hidden>
      </div>
    </section>
  </div>`;
}

function openColab(c, tipo) {
  const v = Object.assign({ tipo, ativo: true }, c);
  const setores = Object.entries(S.clientes.reduce((m, x) => { if (x.setor) m[x.setor] = (m[x.setor] || 0) + 1; return m; }, {})).sort();
  openDialog(`<h2>${v.id ? 'Editar' : 'Novo'} ${v.tipo === 'RN' ? 'RN' : 'promotor'}</h2>
    <label>Nome<input name="nome" value="${esc(v.nome)}" required autofocus></label>
    <fieldset class="seg"><legend>Tipo</legend>${radios('tipo', { RN: 'RN', PROM: 'Promotor' }, v.tipo)}</fieldset>
    <label>Setor VDE (da base de clientes)${setores.length
      ? `<select name="setor">${options(setores.map(([s, n]) => ({ v: s, t: `${s} — ${n} clientes` })), v.setor, 'Sem setor')}</select>`
      : `<input name="setor" value="${esc(v.setor)}" placeholder="Ex.: 00104 (importe a base para escolher da lista)">`}</label>
    <span class="hint">Com o setor definido, na rota com este RN o app sugere os PDVs do setor no dia de visita.</span>
    <label style="display:flex;gap:8px;align-items:center;color:var(--text)"><input type="checkbox" name="ativo" ${v.ativo !== false ? 'checked' : ''}> Ativo</label>
    <span class="hint">Inativo some das listas, mas o histórico continua.</span>
    <div class="err" id="f-err"></div>
    <div class="dlg-actions"><span class="sp"></span><button type="button" class="ghost" data-act="close">Cancelar</button><button class="primary">Salvar</button></div>`, {
    async onSubmit(f) {
      const fd = new FormData(f), nome = (fd.get('nome') || '').trim();
      if (!nome) { $('#f-err', f).textContent = 'Informe o nome.'; return false; }
      const ordem = v.ordem ?? Math.max(0, ...S.colaboradores.map((x) => x.ordem ?? 0)) + 1;
      await save('colaboradores', Object.assign({}, v, { id: v.id || uid(), nome, tipo: fd.get('tipo'), setor: (fd.get('setor') || '').trim(), ativo: fd.get('ativo') === 'on', ordem }));
      toast('Salvo');
    },
  });
}

/* ----- exportações ----- */
function download(blob, name) {
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 3000);
}
async function shareOrDownload(blob, name) {
  const file = new File([blob], name, { type: blob.type });
  if (navigator.canShare?.({ files: [file] }) && matchMedia('(pointer: coarse)').matches) {
    try { await navigator.share({ files: [file], title: name }); return true; } catch (e) { if (e.name === 'AbortError') return false; }
  }
  download(blob, name); return true;
}
function csvBlob(rows) {
  const cell = (v) => { v = String(v ?? ''); return /[;"\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v; };
  return new Blob(['﻿' + rows.map((r) => r.map(cell).join(';')).join('\r\n')], { type: 'text/csv;charset=utf-8' });
}
const brDate = (s) => (s ? s.split('-').reverse().join('/') : '');
function periodo() { const de = $('#ex-de')?.value || '0000', ate = $('#ex-ate')?.value || '9999'; return [de, ate]; }
async function exportCSV(kind) {
  const [de, ate] = periodo();
  const inP = (d) => d >= de && d <= ate;
  const noDia = (v) => S.visitas.filter((x) => x.data === v.data && x.agendaId === v.agendaId).length;
  const pendDe = (v) => S.pendencias.filter((p) => p.visitaId === v.id);
  let rows, name;
  if (kind === 'rn' || kind === 'prom') {
    const isP = kind === 'prom';
    const vs = S.visitas.filter((v) => inP(v.data) && (isP ? v.tipo === 'PROM' : v.tipo !== 'PROM')).sort((a, b) => (a.data + a.hora).localeCompare(b.data + b.hora));
    const itens = [...new Set([...(isP ? cfg().checkPROM : cfg().checkRN), ...vs.flatMap((v) => v.itens.map((i) => i.n))])];
    const head = ['Data', 'Dia', isP ? 'Promotor' : 'RN', 'Cód. PDV', 'Nome do PDV', ...itens, 'Itens OK', '% Execução', 'Status Execução'];
    rows = [isP ? [...head, 'Ocorrência / Observação', 'Pendências', 'PDVs no Dia (Promotor)', 'Fotos']
      : [...head, 'PDV Aderido', 'Pendência', 'Descrição da Pendência', 'Possível CT', 'Tipo de CT', 'Observações', 'PDVs no Dia (RN)', 'Visita Conta? (> mín.)', 'Tipo de rota', 'Fotos']];
    for (const v of vs) {
      const p = execPct(v.itens), aplic = v.itens.filter((i) => i.r !== 'N/A').length, sim = v.itens.filter((i) => i.r === 'Sim').length;
      const base = [brDate(v.data), DIAS[dow(v.data)], v.tipo === 'IND' ? 'Independente' : colabNome(v.colabId), v.codigo, v.nome,
        ...itens.map((n) => v.itens.find((i) => i.n === n)?.r || ''), p == null ? '' : `${sim}/${aplic}`, p == null ? '' : pctTxt(p), p == null ? '' : isExec(v) ? 'Executado' : 'Não Executado'];
      const pe = pendDe(v), n = noDia(v);
      rows.push(isP ? [...base, v.obs, pe.map((x) => x.descricao).join(' | '), n, v.fotos?.length || 0]
        : [...base, v.aderido, pe.length ? 'Sim' : 'Não', pe.map((x) => x.descricao + (x.resolvida ? ' (resolvida)' : '')).join(' | '), v.possivelCT, v.tipoCT, v.obs, n,
          v.tipo === 'RN' ? (n > (Number(cfg().minPdvsRN) || 0) ? 'Sim' : 'Não') : '', TIPOS[v.tipo], v.fotos?.length || 0]);
    }
    name = `visitas-${isP ? 'promotores' : 'rn'}_${de}_${ate}.csv`;
  } else if (kind === 'pend') {
    rows = [['Aberta em', 'Cód. PDV', 'Nome do PDV', 'Pendência', 'Colaborador', 'Situação', 'Resolvida em']];
    for (const p of S.pendencias.filter((p) => inP(p.criada) || (!p.resolvida))) rows.push([brDate(p.criada), p.codigo, p.nomePdv, p.descricao, p.colabId ? colabNome(p.colabId) : '', p.resolvida ? 'Resolvida' : 'Aberta', brDate(p.resolvidaEm)]);
    name = `pendencias_${today()}.csv`;
  } else {
    rows = [['Criado em', 'Ação', 'Responsável', 'Prazo', 'Situação', 'Concluído em', 'Origem']];
    for (const p of S.planos.slice().sort(planoSort)) rows.push([brDate(p.data), p.acao, p.resp, brDate(p.prazo), p.feito ? 'Concluído' : (p.prazo && p.prazo < today() ? 'Atrasado' : 'Aberto'), brDate(p.feitoEm), p.origem]);
    name = `planos-de-acao_${today()}.csv`;
  }
  if (rows.length < 2) { toast('Nada para exportar no período'); return; }
  await shareOrDownload(csvBlob(rows), name);
}

const blobToDataURL = (b) => new Promise((r) => { const fr = new FileReader(); fr.onload = () => r(fr.result); fr.readAsDataURL(b); });
async function exportBackup(comFotos) {
  const data = { app: 'nivel-servico', versao: 2, exportado: new Date().toISOString(), config: S.config };
  for (const s of MEM_STORES) data[s] = S[s];
  if (comFotos) {
    toast('Preparando fotos…');
    data.fotos = await Promise.all((await dbAll('fotos')).map(async (f) => ({ ...f, blob: await blobToDataURL(f.blob) })));
  }
  const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
  const ok = await shareOrDownload(blob, `ns-backup-${today()}${comFotos ? '-com-fotos' : ''}.json`);
  if (!ok) return;
  S.config.ultimoBackup = new Date().toISOString(); await saveConfig(); render(); toast('Backup exportado');
}

async function importBackup(file) {
  let data;
  try { data = JSON.parse(await file.text()); } catch { alert('Arquivo inválido.'); return; }
  if (data.app !== 'nivel-servico') { alert('Este arquivo não é um backup do app Nível de Serviço.'); return; }
  if (!confirm(`Substituir TODOS os dados deste aparelho pelo backup de ${new Date(data.exportado).toLocaleString('pt-BR')}?\n(${data.agenda?.length || 0} compromissos, ${data.visitas?.length || 0} visitas, ${data.clientes?.length || 0} clientes${data.fotos ? `, ${data.fotos.length} fotos` : ''})`)) return;
  for (const s of STORES) if (s !== 'fotos' || data.fotos) await dbClear(s);
  for (const s of MEM_STORES) { S[s] = data[s] || []; await dbPutMany(s, S[s]); }
  if (data.fotos) {
    const fotos = await Promise.all(data.fotos.map(async (f) => ({ ...f, blob: await (await fetch(f.blob)).blob() })));
    await dbPutMany('fotos', fotos);
  }
  S.config = Object.assign(structuredClone(DEFAULT_CFG), data.config, { id: 'main' });
  await saveConfig(); buildIndex();
  render(); toast('Backup importado');
}

/* =========================================================================
   ROTEAMENTO E EVENTOS
   ========================================================================= */
const ROUTES = { hoje: viewHoje, agenda: viewAgenda, pendencias: viewPendencias, promotores: viewPromotores, cadastros: viewCadastros };
function route() {
  const [name, id] = location.hash.replace(/^#\/?/, '').split('?')[0].split('/');
  return { name: name || 'hoje', id };
}

function render() {
  const r = route();
  const nav = r.name === 'dia' ? 'hoje' : (ROUTES[r.name] ? r.name : 'hoje');
  document.querySelectorAll('#nav a').forEach((a) => a.classList.toggle('on', a.dataset.r === nav));
  const y = window.scrollY, same = render.last === location.hash;
  $('#view').innerHTML = r.name === 'dia' ? viewDia(r.id) : (ROUTES[r.name] || viewHoje)();
  render.last = location.hash;
  if (same) window.scrollTo(0, y);
  renderBanner();
  const el = $('#persist');
  if (el) {
    if (navigator.storage?.persisted) navigator.storage.persisted().then((p) => { el.textContent = p ? 'protegido ✓' : 'pode ser limpo pelo sistema'; });
    else el.textContent = 'não informado';
  }
}

function renderBanner() {
  const ub = cfg().ultimoBackup, tem = S.agenda.length + S.pdvs.length + S.visitas.length > 0;
  const dias = ub ? (Date.now() - new Date(ub)) / 864e5 : Infinity;
  $('#banner').innerHTML = tem && dias > 7
    ? `<div class="banner">⚠️ ${ub ? `Último backup há ${Math.floor(dias)} dias.` : 'Você ainda não fez backup.'} Os dados ficam só neste aparelho.<button class="sm" data-act="export">Fazer backup</button></div>`
    : '';
}

async function addPlano(agendaId) {
  const acao = $('#pa-acao')?.value.trim();
  if (!acao) { toast('Descreva o plano de ação'); $('#pa-acao')?.focus(); return; }
  const a = agendaId ? S.agenda.find((x) => x.id === agendaId) : null;
  await save('planos', { id: uid(), agendaId: agendaId || '', data: today(), acao, resp: $('#pa-resp').value.trim(), prazo: $('#pa-prazo').value || '', feito: false, feitoEm: null, origem: a ? `${a.motivo || whoEntry(a)} ${fmtBR(a.data)}` : 'Avulso' });
  render(); $('#pa-acao')?.focus(); toast('Plano de ação adicionado');
}

const ACTIONS = {
  wk: (b) => { ui.week = addDays(ui.week, Number(b.dataset.d)); render(); },
  'wk-today': () => { ui.week = monday(today()); render(); },
  'copy-week': copyWeek,
  'new-entry': (b) => openEntry({ data: b.dataset.date, turno: b.dataset.turno || 'M', tipo: b.dataset.tipo || 'RN', colabId: b.dataset.colab || '' }, { go: !!b.dataset.go }),
  'edit-entry': (b) => openEntry(S.agenda.find((a) => a.id === b.dataset.id)),
  'entry-start': async (b) => { const a = S.agenda.find((x) => x.id === b.dataset.id); a.inicio = new Date().toISOString(); await save('agenda', a); render(); toast('Bom trabalho! ▶'); },
  'entry-end': async (b) => {
    const a = S.agenda.find((x) => x.id === b.dataset.id);
    const nv = visitasDe(a.id).length;
    if (a.tipo !== 'INT' && !nv && !confirm('Nenhum PDV registrado. Encerrar mesmo assim?')) return;
    a.fim = new Date().toISOString(); a.status = 'ok'; await save('agenda', a); render(); toast('Encerrado e marcado como Realizado');
  },
  'entry-reopen': async (b) => { const a = S.agenda.find((x) => x.id === b.dataset.id); a.fim = null; await save('agenda', a); render(); },
  'visita-add': (b) => openPicker(S.agenda.find((a) => a.id === b.dataset.agenda)),
  'visita-edit': (b) => openVisita(b.dataset.id),
  'geo-save': (b) => salvarGeo(b.dataset.cod),
  'pdv-detail': (b) => openPdvDetail(b.dataset.cod),
  'plano-add': (b) => addPlano(b.dataset.agenda),
  'plano-del': async (b) => { if (!confirm('Excluir este plano de ação?')) return; await remove('planos', b.dataset.id); render(); },
  'pend-tab': (b) => { ui.pendTab = b.dataset.tab; saveUI(); if (route().name !== 'pendencias') location.hash = '#/pendencias'; else render(); },
  'pend-filtro': (b) => { ui.pendFiltro = b.dataset.f; saveUI(); render(); },
  'prom-tab': (b) => { ui.promTab = b.dataset.tab; saveUI(); if (route().name !== 'promotores') location.hash = '#/promotores'; else render(); },
  'prom-sel': (b) => { ui.promId = b.dataset.id; saveUI(); render(); },
  'pdv-new': () => openPdv(null),
  'pdv-edit': (b) => openPdv(S.pdvs.find((p) => p.id === b.dataset.id)),
  'pdv-bulk': openBulk,
  'colab-new': (b) => openColab(null, b.dataset.tipo),
  'colab-edit': (b) => openColab(colab(b.dataset.id)),
  'save-list': async (b) => {
    const k = b.dataset.key;
    const vals = [...new Set($(`[data-list="${k}"]`).value.split('\n').map((s) => s.trim()).filter(Boolean))];
    if (!vals.length) { toast('A lista não pode ficar vazia'); return; }
    S.config[k] = vals; await saveConfig(); toast('Lista salva');
  },
  'base-import': () => $('#basefile').click(),
  'csv-rn': () => exportCSV('rn'), 'csv-prom': () => exportCSV('prom'), 'csv-pend': () => exportCSV('pend'), 'csv-planos': () => exportCSV('planos'),
  export: () => exportBackup(false),
  'export-fotos': () => exportBackup(true),
  import: () => $('#importfile').click(),
  close: closeDialog,
};

document.addEventListener('click', (e) => {
  const img = e.target.closest('img[data-view]');
  if (img) { showPhoto(img.dataset.view); return; }
  const b = e.target.closest('[data-act]');
  if (!b) return;
  const act = b.dataset.act;
  const fn = (dlg.open && dlgHandlers.actions?.[act]) || ACTIONS[act];
  if (act === 'close' && b.tagName === 'A') { closeDialog(); return; } // link segue normalmente
  if (fn) { e.preventDefault(); fn(b); }
});
document.addEventListener('input', (e) => {
  const k = e.target.dataset.input;
  if (k) {
    ui[k] = e.target.value;
    const pos = e.target.selectionStart;
    render();
    const el = $(`[data-input="${k}"]`); if (el) { el.focus(); try { el.setSelectionRange(pos, pos); } catch {} }
  }
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.target.closest('.addplano')) { e.preventDefault(); $('.addplano [data-act="plano-add"]')?.click(); }
});
document.addEventListener('change', async (e) => {
  const t = e.target;
  if (t.id === 'importfile' && t.files[0]) { importBackup(t.files[0]); t.value = ''; return; }
  if (t.id === 'basefile' && t.files[0]) { importBase(t.files[0]); t.value = ''; return; }
  if (t.dataset.pend) {
    const p = S.pendencias.find((x) => x.id === t.dataset.pend);
    p.resolvida = t.checked; p.resolvidaEm = t.checked ? today() : null; await save('pendencias', p);
    toast(t.checked ? 'Pendência resolvida ✓' : 'Pendência reaberta');
    if (dlg.open) dlgHandlers.refresh?.(); else render();
    return;
  }
  if (t.dataset.plano) {
    const p = S.planos.find((x) => x.id === t.dataset.plano);
    p.feito = t.checked; p.feitoEm = t.checked ? today() : null; await save('planos', p);
    toast(t.checked ? 'Plano concluído ✓' : 'Plano reaberto'); render(); return;
  }
  if (t.dataset.entryField) {
    const a = S.agenda.find((x) => x.id === t.dataset.id); a[t.dataset.entryField] = t.value; await save('agenda', a); toast('Salvo'); return;
  }
  if (t.dataset.cfg) { S.config[t.dataset.cfg] = Number(t.value) || 0; await saveConfig(); toast('Regra salva'); }
});
window.addEventListener('hashchange', () => { window.scrollTo(0, 0); render(); });

function netStatus() {
  const n = $('#net'); n.classList.toggle('off', !navigator.onLine);
  n.title = navigator.onLine ? 'Online' : 'Offline — tudo continua funcionando';
}
window.addEventListener('online', netStatus);
window.addEventListener('offline', netStatus);

/* ---------- início ---------- */
(async function init() {
  try {
    await load();
  } catch (e) {
    $('#view').innerHTML = `<div class="empty">Não foi possível abrir o armazenamento local.<br><small>${esc(e.message)}</small></div>`;
    return;
  }
  netStatus();
  render();
  if (navigator.storage?.persist) navigator.storage.persist().catch(() => {});
  if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('sw.js').catch(() => {});
})();
