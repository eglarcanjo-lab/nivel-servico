'use strict';
/* =========================================================================
   Nível de Serviço — app pessoal offline
   Módulo 1: Agenda (minha agenda + agenda dos promotores)
   Dados ficam no próprio aparelho (IndexedDB). Backup em JSON.
   ========================================================================= */

/* ---------- utilidades ---------- */
const $ = (s, r = document) => r.querySelector(s);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const norm = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

const pad = (n) => String(n).padStart(2, '0');
const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parse = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const addDays = (s, n) => { const d = parse(s); d.setDate(d.getDate() + n); return iso(d); };
const dow = (s) => { const g = parse(s).getDay(); return g === 0 ? 7 : g; }; // 1=Seg … 7=Dom
const monday = (s) => addDays(s, 1 - dow(s));
const today = () => iso(new Date());
const weeksBetween = (a, b) => Math.round((parse(monday(b)) - parse(monday(a))) / (7 * 864e5));
const fmtBR = (s) => { const d = parse(s); return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}`; };
const mesAno = (s) => parse(s).toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' });

const DIAS = ['', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb', 'Dom'];
const DIAS_SEMANA = [1, 2, 3, 4, 5, 6];
const TURNOS = { M: 'Manhã', T: 'Tarde', D: 'Dia todo' };
const TIPOS = { RN: 'Rota com RN', PROM: 'Rota com Promotor', INT: 'Interno' };
const TIPO_CURTO = { RN: 'RN', PROM: 'PROM', INT: 'INT' };
const STATUS = { plan: 'Planejado', ok: 'Realizado', nao: 'Não realizado', reag: 'Reagendado' };
const STATUS_ICO = { plan: 'Planejado', ok: '✓ Feito', nao: '✗ Não', reag: '↻ Reag.' };
const PERIODOS = { 1: 'Semanal', 2: 'Quinzenal', 4: 'Mensal (a cada 4 sem.)' };

/* ---------- banco local (IndexedDB) ---------- */
const STORES = ['colaboradores', 'pdvs', 'agenda', 'config'];
let db;
function openDB() {
  return new Promise((res, rej) => {
    const r = indexedDB.open('nivel-servico', 1);
    r.onupgradeneeded = () => { for (const s of STORES) if (!r.result.objectStoreNames.contains(s)) r.result.createObjectStore(s, { keyPath: 'id' }); };
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
const dbPut = (s, o) => tx(s, 'readwrite', (os) => os.put(o));
const dbDel = (s, id) => tx(s, 'readwrite', (os) => os.delete(id));
const dbClear = (s) => tx(s, 'readwrite', (os) => os.clear());

/* ---------- estado em memória ---------- */
const S = { colaboradores: [], pdvs: [], agenda: [], config: null };

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

const SEED = {
  // Nomes genéricos de propósito: o código é público. Renomeie em Cadastros.
  rns: Array.from({ length: 10 }, (_, i) => `RN ${pad(i + 1)}`),
  proms: ['Promotor 01', 'Promotor 02'],
  focos: ['Execução de PDV', 'Cobertura / Positivação', 'Pendências', 'Ativação de clientes', 'Merchandising / Ponto extra', 'Ruptura / Abastecimento', 'Possível CT', 'Treinamento do colaborador'],
  motivos: ['Reunião de Nível de Serviço', 'Relatórios / KPIs', 'Tratativa de pendências', 'Reunião com gerente', 'Treinamento', 'Administrativo'],
};

async function load() {
  db = await openDB();
  for (const s of STORES) {
    const all = await dbAll(s);
    if (s === 'config') S.config = all.find((c) => c.id === 'main') || null; else S[s] = all;
  }
  if (!S.config) {
    S.config = { id: 'main', focos: SEED.focos, motivos: SEED.motivos, ultimoBackup: null, criado: new Date().toISOString() };
    await saveConfig();
    let o = 0;
    for (const n of SEED.rns) await save('colaboradores', { id: uid(), nome: n, tipo: 'RN', ativo: true, ordem: o++ });
    for (const n of SEED.proms) await save('colaboradores', { id: uid(), nome: n, tipo: 'PROM', ativo: true, ordem: o++ });
  }
}

const colabs = (tipo, incluirInativos = false) =>
  S.colaboradores.filter((c) => c.tipo === tipo && (incluirInativos || c.ativo !== false))
    .sort((a, b) => (a.ordem ?? 0) - (b.ordem ?? 0) || a.nome.localeCompare(b.nome));
const colabNome = (id) => S.colaboradores.find((c) => c.id === id)?.nome || '(removido)';

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

/* ---------- estado da interface (lembrado só neste aparelho) ---------- */
const ui = Object.assign({ week: monday(today()), promId: null, promTab: 'agenda', busca: '' }, (() => {
  try { return JSON.parse(localStorage.getItem('ns-ui') || '{}'); } catch { return {}; }
})());
ui.week = monday(today()); // sempre abre na semana atual
const saveUI = () => { try { localStorage.setItem('ns-ui', JSON.stringify({ promId: ui.promId, promTab: ui.promTab })); } catch {} };

/* ---------- feedback ---------- */
let toastT;
function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), 2200);
}

/* ---------- diálogo genérico ---------- */
const dlg = $('#dlg'), dform = $('#dlgform');
let dlgHandlers = {};
function openDialog(html, handlers = {}) {
  dform.innerHTML = html;
  dlgHandlers = handlers;
  dlg.showModal();
  handlers.onOpen?.(dform);
  const first = dform.querySelector('[autofocus]');
  if (first && matchMedia('(min-width: 600px)').matches) first.focus();
}
function closeDialog() { dlg.close(); dform.innerHTML = ''; dlgHandlers = {}; }
dform.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (dlgHandlers.onSubmit) {
    const ok = await dlgHandlers.onSubmit(dform);
    if (ok !== false) { closeDialog(); render(); }
  }
});
dform.addEventListener('change', (e) => dlgHandlers.onChange?.(dform, e));
dlg.addEventListener('click', (e) => { if (e.target === dlg) closeDialog(); });

const radios = (name, map, val) =>
  Object.entries(map).map(([k, v]) => `<label><input type="radio" name="${name}" value="${k}" ${String(val) === String(k) ? 'checked' : ''}><span>${esc(v)}</span></label>`).join('');
const daysPicker = (sel = []) =>
  `<div class="chips">${DIAS_SEMANA.map((d) => `<label><input type="checkbox" name="dias" value="${d}" ${sel.includes(d) ? 'checked' : ''}><span>${DIAS[d]}</span></label>`).join('')}</div>`;
const options = (list, val, placeholder) =>
  (placeholder ? `<option value="">${esc(placeholder)}</option>` : '') +
  list.map((o) => `<option value="${esc(o.v)}" ${String(o.v) === String(val) ? 'selected' : ''}>${esc(o.t)}</option>`).join('');

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
    const mine = ents.filter((a) => a.colabId === id && a.tipo !== 'INT');
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
    <div class="row legend">Turnos na semana: ${turnos('RN')} com RN · ${turnos('PROM')} com promotor · ${turnos('INT')} interno
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
  const who = a.tipo === 'INT' ? (a.motivo || 'Interno') : colabNome(a.colabId);
  let l2 = [...(a.focos || []), a.focoTxt].filter(Boolean).join(' · ');
  if (a.tipo === 'INT' && a.motivoTxt) l2 = [a.motivoTxt, l2].filter(Boolean).join(' · ');
  if (a.tipo !== 'INT' && a.rota) l2 = [a.rota, l2].filter(Boolean).join(' · ');
  if (a.tipo === 'PROM') { const n = pdvsDoDia(a.colabId, a.data).length; if (n) l2 = `${n} PDVs · ${l2}`; }
  return `<button class="entry t-${a.tipo} st-${a.status}" data-act="edit-entry" data-id="${a.id}">
    <span class="l1"><span class="badge">${TIPO_CURTO[a.tipo]}</span><span class="who">${esc(who)}</span><span class="st ${a.status}">${STATUS_ICO[a.status]}</span></span>
    ${l2 ? `<span class="l2">${esc(l2)}</span>` : ''}
  </button>`;
}

function entryDyn(v) {
  if (v.tipo === 'INT') {
    return `<label>Motivo<select name="motivo" required>${options(S.config.motivos.map((m) => ({ v: m, t: m })), v.motivo, 'Escolha o motivo…')}</select></label>
      <label>Detalhe do motivo<input name="motivoTxt" value="${esc(v.motivoTxt)}" placeholder="Opcional"></label>`;
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

function openEntry(a) {
  const v = Object.assign({ data: today(), turno: 'M', tipo: 'RN', status: 'plan', focos: [] }, a);
  const html = `<h2>${v.id ? 'Editar compromisso' : 'Novo compromisso'}</h2>
    <label>Data<input type="date" name="data" value="${v.data}" required></label>
    <fieldset class="seg"><legend>Turno</legend>${radios('turno', TURNOS, v.turno)}</fieldset>
    <fieldset class="seg"><legend>Com quem / onde</legend>${radios('tipo', TIPOS, v.tipo)}</fieldset>
    <div id="f-dyn" style="display:grid;gap:12px">${entryDyn(v)}</div>
    <fieldset><legend>Foco do turno</legend>
      <div class="chips">${S.config.focos.map((f) => `<label><input type="checkbox" name="focos" value="${esc(f)}" ${v.focos?.includes(f) ? 'checked' : ''}><span>${esc(f)}</span></label>`).join('')}</div>
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
      if (n.tipo !== 'INT' && !n.colabId) { err.textContent = 'Escolha o colaborador.'; return false; }
      if (n.tipo === 'INT' && !n.motivo) { err.textContent = 'Escolha o motivo do dia interno.'; return false; }
      if (n.tipo === 'INT') { n.colabId = ''; n.rota = ''; } else { n.motivo = ''; n.motivoTxt = ''; }
      await save('agenda', Object.assign({ id: v.id || uid(), criado: v.criado || new Date().toISOString() }, n));
      if (n.data < ui.week || n.data > addDays(ui.week, 6)) ui.week = monday(n.data);
      toast('Compromisso salvo');
    },
    actions: {
      'del-entry': async () => {
        if (!confirm('Excluir este compromisso?')) return;
        await remove('agenda', v.id); closeDialog(); render(); toast('Compromisso excluído');
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
    await save('agenda', Object.assign({}, a, { id: uid(), data: addDays(a.data, 7), status: 'plan', obs: '', criado: new Date().toISOString() }));
  }
  render(); toast(`${novos.length} compromisso(s) copiado(s)`);
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
        codigo: (fd.get('codigo') || '').trim(), nome: (fd.get('nome') || '').trim(), bairro: (fd.get('bairro') || '').trim(),
        promotorId: fd.get('promotorId'), dias: fd.getAll('dias').map(Number), cadaSemanas: Number(fd.get('cadaSemanas')) || 1,
        inicio: fd.get('inicio') || monday(today()), ativo: fd.get('ativo') === 'on', obs: (fd.get('obs') || '').trim(),
      };
      if (!n.nome) { err.textContent = 'Informe o nome do PDV.'; return false; }
      if (!n.dias.length) { err.textContent = 'Marque pelo menos um dia de visita.'; return false; }
      const dup = n.codigo && S.pdvs.find((x) => x.codigo === n.codigo && x.promotorId === n.promotorId && x.id !== p?.id);
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
    <p class="hint" style="margin:0">Uma linha por PDV: <b>código</b> e <b>nome</b> separados por TAB (copiado do Excel), ponto e vírgula ou traço. Os dias e a periodicidade abaixo valem para todos — depois dá para ajustar um a um.</p>
    <textarea name="lista" rows="8" placeholder="20357	SQUINA MAR ACAU&#10;20002;BAR DA FAVA" autofocus></textarea>
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
        const codigo = m ? m[1].trim() : '', nome = m ? m[2].trim() : l;
        if (codigo && S.pdvs.some((x) => x.codigo === codigo && x.promotorId === promotorId)) { pulados++; continue; }
        await save('pdvs', { id: uid(), codigo, nome, bairro: '', promotorId, dias, cadaSemanas: Number(fd.get('cadaSemanas')) || 1, inicio: fd.get('inicio') || monday(today()), ativo: true, obs: '', criado: new Date().toISOString() });
        novos++;
      }
      if (!novos && !pulados) { err.textContent = 'Cole pelo menos uma linha.'; return false; }
      ui.promId = promotorId;
      toast(`${novos} PDV(s) importado(s)${pulados ? `, ${pulados} já existiam` : ''}`);
    },
  });
}

/* =========================================================================
   CADASTROS + DADOS
   ========================================================================= */
function viewCadastros() {
  const lista = (tipo, titulo) => `<section class="card">
    <header><h3>${titulo}</h3><button class="sm" data-act="colab-new" data-tipo="${tipo}">+ Adicionar</button></header>
    <div class="list">${colabs(tipo, true).map((c) => `<button class="item ${c.ativo === false ? 'off' : ''}" data-act="colab-edit" data-id="${c.id}">
      <span class="main"><b>${esc(c.nome)}</b>${c.ativo === false ? '<small>inativo</small>' : ''}</span><small>Editar</small></button>`).join('') || '<div class="empty">Ninguém cadastrado</div>'}</div>
  </section>`;
  const listaTxt = (key, titulo, hint) => `<section class="card">
    <header><h3>${titulo}</h3></header>
    <span class="hint">${hint}</span>
    <textarea rows="7" data-list="${key}">${esc(S.config[key].join('\n'))}</textarea>
    <button class="sm" data-act="save-list" data-key="${key}" style="justify-self:start">Salvar lista</button>
  </section>`;
  const ub = S.config.ultimoBackup;
  return `<div class="grid2">
    ${lista('RN', 'RNs')}
    ${lista('PROM', 'Promotores')}
    ${listaTxt('focos', 'Focos do dia/turno', 'Um por linha. Aparecem como opções ao criar um compromisso.')}
    ${listaTxt('motivos', 'Motivos de dia interno', 'Um por linha. Ex.: reunião de quarta, relatórios…')}
    <section class="card">
      <header><h3>Dados e backup</h3></header>
      <div class="kv">
        <span class="muted">Compromissos</span><b>${S.agenda.length}</b>
        <span class="muted">PDVs na base</span><b>${S.pdvs.length}</b>
        <span class="muted">Último backup</span><b>${ub ? new Date(ub).toLocaleString('pt-BR') : 'nunca'}</b>
        <span class="muted">Armazenamento</span><b id="persist">verificando…</b>
      </div>
      <span class="hint">Os dados ficam só neste aparelho. Faça backup com frequência e guarde o arquivo (Drive, e-mail…). Para passar do celular para o PC, exporte num e importe no outro.</span>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <button class="primary" data-act="export">Exportar backup</button>
        <button data-act="import">Importar backup</button>
        <input type="file" id="importfile" accept="application/json,.json" hidden>
      </div>
    </section>
  </div>`;
}

function openColab(c, tipo) {
  const v = Object.assign({ tipo, ativo: true }, c);
  openDialog(`<h2>${v.id ? 'Editar' : 'Novo'} ${v.tipo === 'RN' ? 'RN' : 'promotor'}</h2>
    <label>Nome<input name="nome" value="${esc(v.nome)}" required autofocus></label>
    <fieldset class="seg"><legend>Tipo</legend>${radios('tipo', { RN: 'RN', PROM: 'Promotor' }, v.tipo)}</fieldset>
    <label style="display:flex;gap:8px;align-items:center;color:var(--text)"><input type="checkbox" name="ativo" ${v.ativo !== false ? 'checked' : ''}> Ativo</label>
    <span class="hint">Inativo some das listas, mas o histórico continua.</span>
    <div class="err" id="f-err"></div>
    <div class="dlg-actions"><span class="sp"></span><button type="button" class="ghost" data-act="close">Cancelar</button><button class="primary">Salvar</button></div>`, {
    async onSubmit(f) {
      const fd = new FormData(f), nome = (fd.get('nome') || '').trim();
      if (!nome) { $('#f-err', f).textContent = 'Informe o nome.'; return false; }
      const ordem = v.ordem ?? Math.max(0, ...S.colaboradores.map((x) => x.ordem ?? 0)) + 1;
      await save('colaboradores', Object.assign({}, v, { id: v.id || uid(), nome, tipo: fd.get('tipo'), ativo: fd.get('ativo') === 'on', ordem }));
      toast('Salvo');
    },
  });
}

async function exportBackup() {
  const data = { app: 'nivel-servico', versao: 1, exportado: new Date().toISOString(), colaboradores: S.colaboradores, pdvs: S.pdvs, agenda: S.agenda, config: S.config };
  const blob = new Blob([JSON.stringify(data, null, 1)], { type: 'application/json' });
  const name = `ns-backup-${today()}.json`;
  const file = new File([blob], name, { type: 'application/json' });
  if (navigator.canShare?.({ files: [file] }) && matchMedia('(pointer: coarse)').matches) {
    try { await navigator.share({ files: [file], title: name }); } catch (e) { if (e.name === 'AbortError') return; }
  } else {
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }
  S.config.ultimoBackup = new Date().toISOString(); await saveConfig(); render(); toast('Backup exportado');
}

async function importBackup(file) {
  let data;
  try { data = JSON.parse(await file.text()); } catch { alert('Arquivo inválido.'); return; }
  if (data.app !== 'nivel-servico') { alert('Este arquivo não é um backup do app Nível de Serviço.'); return; }
  if (!confirm(`Substituir TODOS os dados deste aparelho pelo backup de ${new Date(data.exportado).toLocaleString('pt-BR')}?\n(${data.agenda?.length || 0} compromissos, ${data.pdvs?.length || 0} PDVs)`)) return;
  for (const s of STORES) await dbClear(s);
  for (const s of ['colaboradores', 'pdvs', 'agenda']) { S[s] = []; for (const o of data[s] || []) { S[s].push(o); await dbPut(s, o); } }
  S.config = Object.assign({ id: 'main', focos: SEED.focos, motivos: SEED.motivos }, data.config, { id: 'main' });
  await saveConfig();
  render(); toast('Backup importado');
}

/* =========================================================================
   ROTEAMENTO E EVENTOS
   ========================================================================= */
const ROUTES = { agenda: viewAgenda, promotores: viewPromotores, cadastros: viewCadastros };
const route = () => (location.hash.replace(/^#\/?/, '').split('?')[0] || 'agenda');

function render() {
  const r = ROUTES[route()] ? route() : 'agenda';
  document.querySelectorAll('#nav a').forEach((a) => a.classList.toggle('on', a.dataset.r === r));
  $('#view').innerHTML = ROUTES[r]();
  renderBanner();
  if (r === 'cadastros') {
    const el = $('#persist');
    if (navigator.storage?.persisted) navigator.storage.persisted().then((p) => { el.textContent = p ? 'protegido ✓' : 'pode ser limpo pelo sistema'; });
    else el.textContent = 'não informado';
  }
}

function renderBanner() {
  const ub = S.config.ultimoBackup, tem = S.agenda.length + S.pdvs.length > 0;
  const dias = ub ? (Date.now() - new Date(ub)) / 864e5 : Infinity;
  $('#banner').innerHTML = tem && dias > 7
    ? `<div class="banner">⚠️ ${ub ? `Último backup há ${Math.floor(dias)} dias.` : 'Você ainda não fez backup.'} Os dados ficam só neste aparelho.<button class="sm" data-act="export">Fazer backup</button></div>`
    : '';
}

const ACTIONS = {
  wk: (b) => { ui.week = addDays(ui.week, Number(b.dataset.d)); render(); },
  'wk-today': () => { ui.week = monday(today()); render(); },
  'copy-week': copyWeek,
  'new-entry': (b) => openEntry({ data: b.dataset.date, turno: b.dataset.turno || 'M', tipo: b.dataset.tipo || 'RN', colabId: b.dataset.colab || '' }),
  'edit-entry': (b) => openEntry(S.agenda.find((a) => a.id === b.dataset.id)),
  'prom-tab': (b) => { ui.promTab = b.dataset.tab; saveUI(); if (route() !== 'promotores') location.hash = '#/promotores'; else render(); },
  'prom-sel': (b) => { ui.promId = b.dataset.id; saveUI(); render(); },
  'pdv-new': () => openPdv(null),
  'pdv-edit': (b) => openPdv(S.pdvs.find((p) => p.id === b.dataset.id)),
  'pdv-bulk': openBulk,
  'colab-new': (b) => openColab(null, b.dataset.tipo),
  'colab-edit': (b) => openColab(S.colaboradores.find((c) => c.id === b.dataset.id)),
  'save-list': async (b) => {
    const k = b.dataset.key;
    const vals = [...new Set($(`[data-list="${k}"]`).value.split('\n').map((s) => s.trim()).filter(Boolean))];
    if (!vals.length) { toast('A lista não pode ficar vazia'); return; }
    S.config[k] = vals; await saveConfig(); toast('Lista salva');
  },
  export: exportBackup,
  import: () => $('#importfile').click(),
  close: closeDialog,
};

document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-act]');
  if (!b) return;
  const act = b.dataset.act;
  const fn = (dlg.open && dlgHandlers.actions?.[act]) || ACTIONS[act];
  if (fn) { e.preventDefault(); fn(b); }
});
document.addEventListener('input', (e) => {
  if (e.target.dataset.input === 'busca') {
    ui.busca = e.target.value;
    const pos = e.target.selectionStart;
    render();
    const el = $('[data-input="busca"]'); el.focus(); el.setSelectionRange(pos, pos);
  }
});
document.addEventListener('change', (e) => {
  if (e.target.id === 'importfile' && e.target.files[0]) { importBackup(e.target.files[0]); e.target.value = ''; }
});
window.addEventListener('hashchange', render);

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
