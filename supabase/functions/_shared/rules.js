// Game rules shared by the browser game and the server functions, so prices, missions and
// run limits can never drift apart. Plain script: the game loads it with <script src>, the
// Edge Functions import it for its side effect and read globalThis.RCRULES.
(function(root){
'use strict';

const GAME_VERSION = 2;                       // bump when scoring or physics change
const SUPPORTED_VERSIONS = [2];

const TRUCK_IDS = ['blaze', 'bulldog', 'shark', 'howler'];
const TRUCK_PRICE = {blaze:0, bulldog:150, shark:300, howler:500};
const POWER_IDS = ['jump', 'magnet', 'shield', 'turbo'];
const UPG_COST = [100, 250, 500];             // price of level 1, 2, 3
const UPG_MAX = UPG_COST.length;
const DEATH_IDS = ['flip','shatter','orbit','balls','pancake','wheels','kaboom','pixels','ghost','balloon'];
const THEME_IDS = ['city', 'farm', 'suburb', 'show'];
const THEME_NAMES = {city:'City', farm:'Farmland', suburb:'Suburbs', show:'Monster truck show'};

// Everything that can be bought. Item ids are what the server stores in owned_items.
function catalog(){
  const items = [];
  for(const id of TRUCK_IDS) items.push({item_id:'truck:'+id, kind:'truck', price:TRUCK_PRICE[id], requires:null});
  for(const p of POWER_IDS) for(let l=1; l<=UPG_MAX; l++)
    items.push({item_id:`upg:${p}:${l}`, kind:'upgrade', price:UPG_COST[l-1], requires: l>1 ? `upg:${p}:${l-1}` : null});
  return items;
}
// owned item ids -> {trucks:[...], upgrades:{jump:n,...}}
function inventory(itemIds){
  const set = new Set(itemIds);
  const trucks = TRUCK_IDS.filter(id => id==='blaze' || set.has('truck:'+id));
  const upgrades = {};
  for(const p of POWER_IDS){ let l = 0; while(l < UPG_MAX && set.has(`upg:${p}:${l+1}`)) l++; upgrades[p] = l; }
  return {trucks, upgrades};
}

// ---------- physics limits used to check a run ----------
const START_SPEED = 14, MAX_SPEED = 31, SPEED_RAMP = 0.011, TURBO_MUL = 1.5;
// Fastest possible time (s) to cover `dist` metres, pretending Nitro is on the whole run.
function minTimeForDist(dist){
  const k = SPEED_RAMP, t = TURBO_MUL;
  const dCap = (MAX_SPEED - START_SPEED) / k;              // where the speed curve tops out
  const d1 = Math.min(dist, dCap);
  let s = Math.log((START_SPEED + k*d1) / START_SPEED) / (k*t);
  if(dist > dCap) s += (dist - dCap) / (MAX_SPEED*t);
  return s;
}
// Points each stunt can pay (×1 .. ×5 combo). Tricks pay 75 (roll) or 100 (flip).
const STUNT_PTS = {ramps:[10,10], bumps:[5,5], tricks:[75,100], bigAir:[25,25], roofs:[15,15],
                   nearMiss:[20,20], crushed:[30,30], bins:[10,10], smashes:[50,100]};
const MAX_COMBO = 5;
// Caps: about 2–4× what a coin-and-stunt-hunting test bot reached (1,500 m: 0.11 coins/m,
// 0.018 stunts/m, 0.8 tricks per jump). Bonus is checked exactly from the stunt counts below.
const LIMITS = {
  minPlaySeconds: 0, maxPlaySeconds: 2*3600,
  clockSlackSeconds: 5,      // play time can't exceed wall-clock time from run-start plus this
  coinsPerMetre: 0.25,       // coins spawn at ~0.14/m; a perfect run can't beat that by much
  stuntsPerMetre: 0.08,      // ramps+bumps+crushed+bins+roofs+nearMiss+smashes
  tricksPerAirborne: 4,
  powersPerMetre: 0.02,
  superJumpsPerSecond: 1.5,
};

const RUN_STAT_KEYS = ['roofs','ramps','bumps','powers','superJumps','smashes','bigAir','nearMiss','tricks','maxMult','crushed','bins'];
const score = r => Math.floor(r.dist) + r.coins*10 + r.bonus;

// Returns null when the run is plausible, or a short reason when it isn't.
// r = {version, dist, coins, bonus, playTime, stats:{...RUN_STAT_KEYS, themes:[], themeCoins:{}}, crash}
// wallSeconds = server-measured time between run-start and run-finish.
function checkRun(r, wallSeconds){
  const L = LIMITS, s = r.stats || {};
  const int = v => Number.isInteger(v) && v >= 0;
  if(!SUPPORTED_VERSIONS.includes(r.version)) return 'old game version';
  if(!(typeof r.dist==='number' && isFinite(r.dist) && r.dist >= 0)) return 'bad distance';
  if(!int(r.coins) || !int(r.bonus)) return 'bad numbers';
  if(!(typeof r.playTime==='number' && isFinite(r.playTime))) return 'bad play time';
  for(const k of RUN_STAT_KEYS) if(!int(s[k])) return 'bad stats';
  if(r.playTime < L.minPlaySeconds || r.playTime > L.maxPlaySeconds) return 'play time out of range';
  if(r.playTime > wallSeconds + L.clockSlackSeconds) return 'played longer than the run existed';
  if(r.playTime < minTimeForDist(r.dist) * 0.97) return 'too fast';
  if(r.coins > 10 + r.dist * L.coinsPerMetre) return 'too many coins';
  const themeCoins = s.themeCoins || {};
  let tc = 0;
  for(const [k, v] of Object.entries(themeCoins)){ if(!THEME_IDS.includes(k) || !int(v)) return 'bad stats'; tc += v; }
  if(tc !== r.coins) return 'coin stats mismatch';
  if(!Array.isArray(s.themes) || s.themes.some(t=>!THEME_IDS.includes(t))) return 'bad stats';
  if(s.maxMult < 1 || s.maxMult > MAX_COMBO) return 'bad combo';
  const stunts = s.ramps + s.bumps + s.crushed + s.bins + s.roofs + s.nearMiss + s.smashes;
  if(stunts > 3 + r.dist * L.stuntsPerMetre) return 'too many stunts';
  const airborne = s.ramps + s.bumps + s.crushed + s.superJumps + 1;
  if(s.tricks > airborne * L.tricksPerAirborne) return 'too many tricks';
  if(s.bigAir > airborne) return 'too much air';
  if(s.powers > 2 + r.dist * L.powersPerMetre) return 'too many powers';
  if(s.superJumps > 3 + r.playTime * L.superJumpsPerSecond) return 'too many jumps';
  if(s.smashes > s.powers + 1) return 'too many smashes';
  let lo = 0, hi = 0;
  for(const [k, [a, b]] of Object.entries(STUNT_PTS)){ lo += s[k]*a; hi += s[k]*b; }
  if(r.bonus < lo || r.bonus > hi * s.maxMult) return 'bonus doesn\'t add up';
  if(s.maxMult > 1 && stunts + s.tricks < 2) return 'bad combo';
  if(r.crash != null && !DEATH_IDS.includes(r.crash)) return 'bad crash';
  return null;
}

// ---------- missions ----------
const MISSION_TYPES = [
  {type:'coinsRun',   levels:[30,60,100],     reward:[50,100,175], text:n=>`Collect ${n} coins in one run`},
  {type:'coinsTotal', levels:[100,250,500],   reward:[60,120,200], text:n=>`Collect ${n} coins in total`, total:true},
  {type:'dist',       levels:[500,1000,2000], reward:[50,100,200], text:n=>`Drive ${n.toLocaleString('en')} m in one run`},
  {type:'score',      levels:[1000,2500,5000],reward:[60,120,220], text:n=>`Score ${n.toLocaleString('en')} in one run`},
  {type:'roofs',      levels:[2,4,7],         reward:[60,110,180], text:n=>`Land on ${n} car roofs in one run`},
  {type:'ramps',      levels:[2,4,6],         reward:[50,100,160], text:n=>`Jump off ${n} trailer ramps in one run`},
  {type:'bumps',      levels:[5,15,30],       reward:[50,100,160], text:n=>`Hop ${n} road-work bumps in total`, total:true},
  {type:'powers',     levels:[2,4,6],         reward:[60,110,180], text:n=>`Pick up ${n} super powers in one run`},
  {type:'superJumps', levels:[3,6,10],        reward:[60,110,170], text:n=>`Use Super Jump ${n} times in one run`},
  {type:'smashes',    levels:[2,5,10],        reward:[80,150,250], text:n=>`Smash ${n} cars with Shield or Nitro`, total:true},
  {type:'bigAir',     levels:[2,4,7],         reward:[60,110,170], text:n=>`Get ${n} BIG AIR bonuses in one run`},
  {type:'theme',      levels:['farm','suburb','show'], reward:[80,80,100], text:t=>`Reach the ${THEME_NAMES[t]} in one run`, pickAny:true},
  {type:'themeCoins', levels:[['farm',15],['suburb',15],['show',15]], reward:[90,90,100], text:g=>`Collect ${g[1]} coins in the ${THEME_NAMES[g[0]]} in one run`, pickAny:true},
  {type:'crash',      levels:[1],             reward:[75],         text:()=>'Discover a crash style you haven’t seen'},
  {type:'nearMiss',   levels:[3,6,10],        reward:[60,110,180], text:n=>`Get ${n} near misses in one run`},
  {type:'tricks',     levels:[2,4,8],         reward:[70,120,200], text:n=>`Land ${n} air tricks in one run`},
  {type:'combo',      levels:[3,4,5],         reward:[60,110,180], text:n=>`Reach a ×${n} combo`},
  {type:'crushed',    levels:[3,6,10],        reward:[60,110,180], text:n=>`Crush ${n} junk cars at the truck show in one run`},
];
const missionDef = m => MISSION_TYPES.find(t=>t.type===m.type);
const goalNum = m => m.type==='themeCoins' ? m.goal[1] : (m.type==='theme' || m.type==='crash') ? 1 : m.goal;

function newMission(exclude, missionsDone, crashesFound, rng){
  const pool = MISSION_TYPES.filter(d=>!exclude.includes(d.type) && !(d.type==='crash' && crashesFound>=DEATH_IDS.length));
  const d = pool[(rng()*pool.length)|0];
  const tier = Math.min(d.levels.length-1, Math.floor(missionsDone/3) + (rng()<0.3 ? 1 : 0));
  const i = d.pickAny ? (rng()*d.levels.length|0) : tier;
  return {type:d.type, goal:d.levels[i], reward:d.reward[i], base:0, done:false};
}
function fillMissions(missions, missionsDone, crashesFound, rng){
  const out = (missions||[]).filter(m=>!m.done && missionDef(m));
  while(out.length < 3) out.push(newMission(out.map(m=>m.type), missionsDone, crashesFound, rng));
  return out;
}
// Progress of mission m. live = {coins, dist, score, newCrash, ...stats} for the current run,
// or null between runs. Totals add the run onto what earlier runs banked in m.base.
function missionValue(m, live){
  const total = missionDef(m).total;
  if(!live) return total ? m.base : 0;
  switch(m.type){
    case 'coinsRun': return live.coins;
    case 'coinsTotal': return m.base + live.coins;
    case 'dist': return Math.floor(live.dist);
    case 'score': return live.score;
    case 'roofs': return live.roofs;
    case 'ramps': return live.ramps;
    case 'bumps': return m.base + live.bumps;
    case 'powers': return live.powers;
    case 'superJumps': return live.superJumps;
    case 'smashes': return m.base + live.smashes;
    case 'bigAir': return live.bigAir;
    case 'theme': return live.themes.includes(m.goal) ? 1 : 0;
    case 'themeCoins': return live.themeCoins[m.goal[0]] || 0;
    case 'crash': return live.newCrash ? 1 : 0;
    case 'nearMiss': return live.nearMiss;
    case 'tricks': return live.tricks;
    case 'combo': return live.maxMult;
    case 'crushed': return live.crushed;
  }
  return 0;
}
// Shape check for missions coming back from storage.
function validMission(m){
  if(!m || typeof m!=='object') return false;
  const d = missionDef(m); if(!d) return false;
  const i = d.levels.findIndex(l => JSON.stringify(l)===JSON.stringify(m.goal));
  return i >= 0 && m.reward === d.reward[i] && Number.isInteger(m.base) && m.base >= 0 && typeof m.done==='boolean';
}
// Close out a finished run: mark missions done, fold totals into base. Returns the reward earned.
function settleMissions(missions, live){
  let reward = 0, done = 0;
  for(const m of missions){
    if(m.done) continue;
    const v = missionValue(m, live);
    if(v >= goalNum(m)){ m.done = true; reward += m.reward; done++; }
    else if(missionDef(m).total) m.base = v;
  }
  return {reward, done};
}

root.RCRULES = Object.freeze({
  GAME_VERSION, SUPPORTED_VERSIONS, TRUCK_IDS, TRUCK_PRICE, POWER_IDS, UPG_COST, UPG_MAX, DEATH_IDS, THEME_IDS, THEME_NAMES,
  catalog, inventory, START_SPEED, MAX_SPEED, SPEED_RAMP, TURBO_MUL, minTimeForDist, STUNT_PTS, MAX_COMBO, LIMITS,
  RUN_STAT_KEYS, score, checkRun, MISSION_TYPES, missionDef, goalNum, newMission, fillMissions, missionValue,
  validMission, settleMissions,
});
})(typeof globalThis !== 'undefined' ? globalThis : this);
