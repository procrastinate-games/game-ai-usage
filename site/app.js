// Privacy-first static dashboard. Only reads per-game aggregate token counts.
const $ = (id) => document.getElementById(id);
const fmt = (v) => Number.isFinite(v) ? v.toLocaleString('en-US') : '—';
const safe = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

function total(games, field) {
  const vals = games.map(g => g[field]).filter(Number.isFinite);
  return vals.length ? vals.reduce((a,b) => a+b,0) : null;
}
function value(g, field) {
  if (!Number.isFinite(g[field])) return '<span class="muted">—</span>';
  const prefix = g.complete ? '' : '<span title="Incomplete usage data: at least this many tokens">≥</span>';
  return prefix + fmt(g[field]);
}
function render(data) {
  if (data.schema !== 'game-ai-usage/usage@2' || !Array.isArray(data.games)) throw new Error('Unsupported privacy-safe data format');
  const games = data.games;
  const allComplete = games.every(g => g.complete);
  const valid = games.filter(g => Number.isFinite(g.processed_tokens));
  const max = Math.max(1, ...valid.map(g => g.processed_tokens));
  const knownTotal = total(games, 'processed_tokens');
  const knownNco = total(games, 'noncached_output_tokens');
  $('meta').textContent = games.length + ' games · per-game token totals';
  $('stats-row').innerHTML =
    '<div class="stat-card"><div class="label">Total processed tokens</div><div class="value">'+(allComplete?'':'≥')+fmt(knownTotal)+'</div><div class="sub">Includes cache reads and writes</div></div>'+
    '<div class="stat-card"><div class="label">Non-cached + output</div><div class="value">'+(allComplete?'':'≥')+fmt(knownNco)+'</div><div class="sub">Excludes cache reads and writes</div></div>'+
    '<div class="stat-card"><div class="label">Games with known usage</div><div class="value">'+valid.length+' / '+games.length+'</div><div class="sub">Unknown counts are not treated as zero</div></div>';
  $('bars').innerHTML = [...games].sort((a,b)=>(b.processed_tokens??-1)-(a.processed_tokens??-1)).map(g => {
    const width = Number.isFinite(g.processed_tokens) ? 100*g.processed_tokens/max : 0;
    return '<div class="gamebar"><div class="gamebar-name">'+safe(g.title)+'</div><div class="gamebar-track"><div class="gamebar-fill" style="width:'+width.toFixed(2)+'%"></div></div><div class="gamebar-value">'+value(g,'processed_tokens')+'</div></div>';
  }).join('');
  const rows = [...games].sort((a,b)=>(b.processed_tokens??-1)-(a.processed_tokens??-1)).map(g =>
    '<tr><td>'+safe(g.title)+'</td><td class="num">'+value(g,'processed_tokens')+'</td><td class="num">'+value(g,'noncached_output_tokens')+'</td></tr>').join('');
  $('games-table').innerHTML='<thead><tr><th>Game</th><th>Total processed</th><th>Non-cached + output</th></tr></thead><tbody>'+rows+'</tbody>';
  $('note').textContent=games.every(g=>g.complete)?'All game totals complete.':'Some games have no reports or incomplete metrics. Totals marked ≥ are lower bounds.';
}
async function boot() {
  try {
    const response = await fetch('data/usage.json', {cache:'no-store'});
    if (!response.ok) throw new Error('HTTP '+response.status);
    render(await response.json());
  } catch(e) {
    $('meta').textContent='Data unavailable';
    $('note').textContent='Could not load privacy-safe aggregate data: '+e.message;
  }
}
boot();
