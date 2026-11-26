// RC Rampage online layer: passwordless email-link sign-in, server-owned progress, ranked runs and the leaderboard.
// The browser only ever reads the public leaderboard directly. Everything else goes through the
// Edge Functions in supabase/functions, which check the signed-in user and validate every request.
(function(){
'use strict';

// Public values only. The publishable/anon key is safe in the page: the database grants it nothing
// except get_leaderboard(). Leave SUPABASE_URL empty to run the game fully offline.
const CONFIG = {
  SUPABASE_URL: 'https://mreqfxafulpslzkelshy.supabase.co',
  SUPABASE_KEY: 'sb_publishable_saXP8VSd4RhAnZ1vLkWmLA_9By1u9N6',
  TURNSTILE_SITE_KEY: '',
};

const $ = id => document.getElementById(id);
const enabled = !!(CONFIG.SUPABASE_URL && CONFIG.SUPABASE_KEY && window.supabase);
const listeners = {auth:[], state:[]};
const emit = (ev, v) => listeners[ev].forEach(fn => { try{ fn(v); }catch(e){ console.error(e); } });
let sb = null, user = null, state = null;

const MESSAGES = {
  offline: 'Can’t reach the server. Check your connection.',
  not_signed_in: 'Your session expired. Sign in again.',
  slow_down: 'Too many requests. Wait a moment and try again.',
  daily_limit: 'You’ve hit today’s limit of ranked runs.',
  bad_name: 'Use 3–16 letters, numbers, spaces, - or _.',
  name_not_allowed: 'That name isn’t allowed. Try another.',
  name_taken: 'That name is taken.',
  rename_cooldown: 'You can change your name once a day.',
  not_enough_coins: 'Not enough coins.',
  needs_previous: 'Buy the previous level first.',
  already_owned: 'You already own that.',
  not_owned: 'You don’t own that truck yet.',
  needs_name: 'Pick a driver name to get ranked.',
  update_game: 'A new version of the game is out. Reload the page.',
  run_not_open: 'This run expired before it was sent.',
  banned: 'This account can’t post scores.',
  server_error: 'Something went wrong on our side. Try again.',
  payments_unavailable: 'Payments aren’t available right now. Try again later.',
  unknown_item: 'That item isn’t for sale.',
};
const message = code => MESSAGES[code] || String(code || 'server_error').replace(/_/g, ' ');

class OnlineError extends Error { constructor(code, status){ super(code); this.code = code; this.status = status; } }

async function call(fn, body){
  const { data } = await sb.auth.getSession();
  const token = data.session?.access_token;
  if(!token) throw new OnlineError('not_signed_in', 401);
  let res;
  try{
    res = await fetch(`${CONFIG.SUPABASE_URL}/functions/v1/${fn}`, {
      method: 'POST',
      headers: {'Authorization': `Bearer ${token}`, 'apikey': CONFIG.SUPABASE_KEY, 'Content-Type': 'application/json'},
      body: JSON.stringify(body || {}),
    });
  }catch(e){ throw new OnlineError('offline', 0); }
  let json = null; try{ json = await res.json(); }catch(e){}
  if(!res.ok) throw new OnlineError(json?.error || 'server_error', res.status);
  return json;
}
function setState(st){ state = st; emit('state', st); return st; }

// ---------- session ----------
let guestSnapshot = () => null;          // the game supplies this: local progress to carry over once
async function onSignedIn(u){
  user = u; emit('auth', u);
  try{
    let res = await call('profile', {action:'get'});
    if(!res.state.imported){
      const snap = guestSnapshot();
      if(snap){ try{ res = await call('import-guest', snap); }catch(e){ console.warn('import', e.code); } }
    }
    setState(res.state);
    flushPending();
    if(!res.state.name) openAccount('name');
    else if(!$('account').hidden && (!$('acSent').hidden || !$('acEmail').hidden)) openAccount();   // signed in from the email link
  }catch(e){
    if(e.code === 'not_signed_in'){ await sb.auth.signOut(); return; }
    console.warn('profile', e.code);
  }
}
function init(){
  if(!enabled) return;
  sb = window.supabase.createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_KEY, {
    auth: {persistSession:true, autoRefreshToken:true, detectSessionInUrl:true, storageKey:'rc-rampage-auth'},
  });
  sb.auth.onAuthStateChange((ev, session) => {
    const u = session?.user || null;
    if(u && (!user || user.id !== u.id)) setTimeout(()=>onSignedIn(u), 0);   // don't await inside the callback
    else if(!u && user){ user = null; state = null; emit('auth', null); }
  });
}

// ---------- ranked runs ----------
const PENDING_KEY = 'rc-rampage-pending-run';
function savePending(r){ try{ localStorage.setItem(PENDING_KEY, JSON.stringify({uid:user?.id, r})); }catch(e){} }
async function flushPending(){
  let p = null; try{ p = JSON.parse(localStorage.getItem(PENDING_KEY) || 'null'); }catch(e){}
  if(!p || !user || p.uid !== user.id) return;
  try{ localStorage.removeItem(PENDING_KEY); }catch(e){}
  try{ const res = await call('run-finish', p.r); setState(res.state); }catch(e){ if(e.code==='offline') savePending(p.r); }
}
async function startRun(truck, version){
  if(!user || !state?.name) return null;
  try{ return (await call('run-start', {truck, version})).runId; }
  catch(e){ console.warn('run-start', e.code); return null; }
}
// report: {version, dist, coins, bonus, playTime, stats, crash}; runId: from startRun (a promise is fine).
async function finishRun(runIdPromise, report){
  if(!user) return {ranked:false, reason:'guest'};
  const runId = await runIdPromise;
  if(!runId) return {ranked:false, reason: state?.name ? 'offline' : 'needs_name'};
  const body = {...report, runId};
  try{
    const res = await call('run-finish', body);
    setState(res.state);
    let rank = null, rankWeek = null;
    if(res.accepted){
      try{
        const [all, week] = await Promise.all([leaderboard('all', 1), leaderboard('week', 1)]);
        rank = all.find(r=>r.me)?.rank ?? null; rankWeek = week.find(r=>r.me)?.rank ?? null;
      }catch(e){}
    }
    return {ranked: res.accepted, reason: res.reason, score: res.score, rank, rankWeek,
            missionReward: res.missionReward || 0, newBest: res.newBest};
  }catch(e){
    if(e.code === 'offline') savePending(body);
    return {ranked:false, reason:e.code};
  }
}
async function buy(item){ return setState((await call('shop-buy', {item})).state); }
async function setTruck(truck){ try{ setState((await call('profile', {action:'truck', truck})).state); }catch(e){} }
async function setSkin(skin){ return setState((await call('profile', {action:'skin', skin})).state); }
async function refresh(){ return setState((await call('profile', {action:'get'})).state); }
// Real-money purchase: the server opens a Stripe Checkout page and we go there. The item is
// added by Stripe's webhook after payment; returning here with ?purchase=success picks it up.
async function checkout(item){
  const { url } = await call('checkout', {item, returnPath: location.pathname});
  if(!/^https:\/\/checkout\.stripe\.com\//.test(url)) throw new OnlineError('payments_unavailable', 0);
  try{ sessionStorage.setItem('rc-rampage-prebuy', JSON.stringify([state?.coins, state?.skins])); }catch(e){}
  location.assign(url);
}
// After Stripe sends the player back: wait for the webhook to land, then tell them.
function handlePurchaseReturn(){
  const q = new URLSearchParams(location.search), r = q.get('purchase');
  if(!r) return;
  q.delete('purchase');
  history.replaceState(null, '', location.pathname + (q.toString() ? '?' + q : '') + location.hash);
  if(r === 'cancel'){ toast('Payment cancelled. You weren’t charged.', true); return; }
  if(r !== 'success') return;
  toast('Payment received! Adding it to your account…');
  let before = null; try{ before = sessionStorage.getItem('rc-rampage-prebuy'); sessionStorage.removeItem('rc-rampage-prebuy'); }catch(e){}
  let tries = 0;
  const poll = async () => {
    tries++;
    if(!user){ if(tries < 10) setTimeout(poll, 1000); return; }
    try{
      const st = await refresh();
      if(before && JSON.stringify([st.coins, st.skins]) !== before){ toast('Thanks! Your purchase is ready.'); return; }
    }catch(e){}
    if(tries < 12) setTimeout(poll, 2500);
    else toast('Your payment went through. It can take a minute to show up; reload if it doesn’t.');
  };
  setTimeout(poll, 1500);
}
let toastTimer = 0;
function toast(text, bad){
  const el = $('toast'); el.textContent = text; el.classList.toggle('bad', !!bad); el.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(()=>{ el.hidden = true; }, 6000);
}
async function leaderboard(board, lim){
  const { data, error } = await sb.rpc('get_leaderboard', {board, lim});
  if(error) throw new OnlineError('offline', 0);
  return data || [];
}

// ---------- shared overlay handling ----------
let returnTo = null;
function showPanel(id){
  const open = ['menu','over'].find(o => !$(o).hidden);
  if(open){ returnTo = open; $(open).hidden = true; }
  for(const o of ['account','board']) $(o).hidden = o !== id;
}
function closeUI(){
  $('account').hidden = true; $('board').hidden = true;
  const back = returnTo || 'menu'; returnTo = null;
  $(back).hidden = false;
  emit('closed', back);
}
listeners.closed = [];

// ---------- account panel ----------
let tsWidget = null, tsToken = '';
function step(name){
  for(const s of ['acEmail','acSent','acName','acMe','acOff']) $(s).hidden = s !== name;
  $('acMsg').textContent = '';
  const focus = {acEmail:'acEmailIn', acSent:'acBack2', acName:'acNameIn', acMe:'acBack'}[name];
  if(focus) setTimeout(()=>$(focus)?.focus(), 30);
}
function say(text, ok){ const m = $('acMsg'); m.textContent = text; m.classList.toggle('ok', !!ok); }
function busy(btn, on){ btn.disabled = on; btn.setAttribute('aria-busy', String(on)); }
function loadTurnstile(){
  if(!CONFIG.TURNSTILE_SITE_KEY || tsWidget !== null) return;
  tsWidget = 'loading';
  window.rcTurnstileReady = () => {
    tsWidget = window.turnstile.render('#tsBox', {
      sitekey: CONFIG.TURNSTILE_SITE_KEY, theme: 'dark', size: 'flexible',
      callback: t => { tsToken = t; }, 'expired-callback': () => { tsToken = ''; }, 'error-callback': () => { tsToken = ''; },
    });
  };
  const s = document.createElement('script');
  s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit&onload=rcTurnstileReady';
  s.async = true; document.head.appendChild(s);
}
function renderMe(){
  $('acWho').textContent = state?.name || '—';
  $('acEmailShow').textContent = user?.email || '';
  $('acDelete').textContent = 'Delete account'; $('acDelete').dataset.armed = '';
}
function openAccount(which){
  if(!enabled){ showPanel('account'); step('acOff'); return; }
  showPanel('account');
  if(which === 'name' || (user && state && !state.name)){ step('acName'); $('acNameIn').value = state?.name || ''; return; }
  if(user){ renderMe(); step('acMe'); return; }
  step('acEmail'); loadTurnstile();
}
async function sendCode(){
  const email = $('acEmailIn').value.trim();
  if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)){ say('Enter a valid email address.'); return; }
  if(CONFIG.TURNSTILE_SITE_KEY && !tsToken){ say('Wait for the robot check to finish, then try again.'); return; }
  const btn = $('acSend'); busy(btn, true);
  const { error } = await sb.auth.signInWithOtp({email, options:{shouldCreateUser:true, captchaToken: tsToken || undefined, emailRedirectTo: location.origin + location.pathname}});
  busy(btn, false);
  if(tsWidget && tsWidget !== 'loading'){ window.turnstile.reset(tsWidget); tsToken = ''; }
  if(error){ say(error.status === 429 ? MESSAGES.slow_down : 'Couldn’t send the code. Check the address and try again.'); return; }
  $('acSentTo').textContent = email;
  step('acSent');
}
async function saveName(){
  const name = $('acNameIn').value.replace(/\s+/g,' ').trim();
  if(!/^[A-Za-z0-9_ -]{3,16}$/.test(name)){ say(MESSAGES.bad_name); return; }
  const btn = $('acSaveName'); busy(btn, true);
  try{ setState((await call('profile', {action:'name', name})).state); renderMe(); step('acMe'); say('Name saved. Your runs are ranked now.', true); }
  catch(e){ say(message(e.code)); }
  busy(btn, false);
}
async function deleteAccount(){
  const btn = $('acDelete');
  if(!btn.dataset.armed){ btn.dataset.armed = '1'; btn.textContent = 'Tap again to delete forever'; say('This permanently deletes your account, coins, trucks and scores.'); return; }
  busy(btn, true);
  try{ await call('delete-account', {confirm:'DELETE'}); await sb.auth.signOut(); closeUI(); }
  catch(e){ say(message(e.code)); }
  busy(btn, false);
}

// ---------- leaderboard panel ----------
let boardTab = 'all';
const TRUCK_COLOR = {blaze:'#ff5a1f', bulldog:'#a3b862', shark:'#3d95f0', howler:'#b06bff'};
async function renderBoard(){
  const list = $('boardList'), note = $('boardNote');
  $('bdAll').setAttribute('aria-selected', String(boardTab==='all'));
  $('bdWeek').setAttribute('aria-selected', String(boardTab==='week'));
  list.textContent = ''; note.textContent = 'Loading…';
  $('boardSignIn').hidden = !enabled || !!user;
  if(!enabled){ note.textContent = 'The online leaderboard isn’t switched on yet.'; return; }
  let rows;
  try{ rows = await leaderboard(boardTab, 50); }catch(e){ note.textContent = MESSAGES.offline; return; }
  note.textContent = rows.length ? '' : (boardTab==='week' ? 'No ranked runs this week yet. Be the first!' : 'No ranked runs yet. Be the first!');
  let prev = 0;
  for(const r of rows){
    if(prev && r.rank > prev + 1){ const gap = document.createElement('li'); gap.className = 'gap'; gap.textContent = '⋯'; list.append(gap); }
    prev = r.rank;
    const li = document.createElement('li'); if(r.me) li.className = 'me';
    const rk = document.createElement('span'); rk.className = 'rk'; rk.textContent = '#' + r.rank;
    const dot = document.createElement('i'); dot.style.background = TRUCK_COLOR[r.truck] || '#888'; dot.title = r.truck;
    const nm = document.createElement('span'); nm.className = 'nm'; nm.textContent = r.name + (r.me ? ' (you)' : '');
    const sc = document.createElement('b'); sc.textContent = Number(r.score).toLocaleString('en');
    li.append(rk, dot, nm, sc); list.append(li);
  }
  if(user && state && !state.name){ note.textContent = 'Pick a driver name in Account to get ranked.'; }
  else if(user && !rows.some(r=>r.me) && rows.length) note.textContent = 'Finish a run to get on the board.';
}
function openBoard(){ showPanel('board'); renderBoard(); setTimeout(()=>$('boardBack').focus(), 30); }

// ---------- wiring ----------
function wire(){
  $('acSend').addEventListener('click', sendCode);
  $('acEmailIn').addEventListener('keydown', e=>{ if(e.key==='Enter') sendCode(); });
  $('acResend').addEventListener('click', ()=>{ step('acEmail'); loadTurnstile(); });
  $('acSaveName').addEventListener('click', saveName);
  $('acNameIn').addEventListener('keydown', e=>{ if(e.key==='Enter') saveName(); });
  $('acRename').addEventListener('click', ()=>{ step('acName'); $('acNameIn').value = state?.name || ''; });
  $('acSignOut').addEventListener('click', async ()=>{ await sb.auth.signOut(); closeUI(); });
  $('acDelete').addEventListener('click', deleteAccount);
  for(const id of ['acBack','acBack2','acBack3','acBack4','acBack5']) $(id).addEventListener('click', closeUI);
  $('bdAll').addEventListener('click', ()=>{ boardTab = 'all'; renderBoard(); });
  $('bdWeek').addEventListener('click', ()=>{ boardTab = 'week'; renderBoard(); });
  $('boardBack').addEventListener('click', closeUI);
  $('boardSignIn').addEventListener('click', ()=>{ $('board').hidden = true; openAccount(); });
}

window.RCOnline = {
  get enabled(){ return enabled; },
  get user(){ return user; },
  get state(){ return state; },
  on(ev, fn){ (listeners[ev] ||= []).push(fn); },
  set guestSnapshot(fn){ guestSnapshot = fn; },
  isOpen: () => !$('account').hidden || !$('board').hidden,
  init(){ wire(); init(); handlePurchaseReturn(); },
  openAccount, openBoard, closeUI, startRun, finishRun, buy, setTruck, setSkin, checkout, refresh, toast, message,
};
})();
