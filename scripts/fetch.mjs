// 定時向中央氣象署、環境部抓資料，整理成網頁要讀的 data/*.json。
// 金鑰只從環境變數讀（GitHub Secrets：CWA_KEY、MOENV_KEY），不會寫進任何輸出檔。
import { mkdir, writeFile, readFile, unlink } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const CWA = (process.env.CWA_KEY || "").trim();
const MOENV = (process.env.MOENV_KEY || "").trim();
const PUSH = (process.env.PUSH_SUB || "").trim();
let PUSH_API = (process.env.PUSH_API || "").trim();
try { PUSH_API = PUSH_API || JSON.parse(readFileSync(new URL("../push-config.json", import.meta.url), "utf8")).api || ""; } catch (e) {}
const PUSH_TOKEN = (process.env.PUSH_TOKEN || "").trim();
const OUT = process.env.OUT_DIR || "data";

// 各縣市「鄉鎮預報」資料集編號：[未來 3 天, 未來 1 週]
const IDS = {
  "宜蘭縣": ["001", "003"], "桃園市": ["005", "007"], "新竹縣": ["009", "011"], "苗栗縣": ["013", "015"],
  "彰化縣": ["017", "019"], "南投縣": ["021", "023"], "雲林縣": ["025", "027"], "嘉義縣": ["029", "031"],
  "屏東縣": ["033", "035"], "臺東縣": ["037", "039"], "花蓮縣": ["041", "043"], "澎湖縣": ["045", "047"],
  "基隆市": ["049", "051"], "新竹市": ["053", "055"], "嘉義市": ["057", "059"], "臺北市": ["061", "063"],
  "高雄市": ["065", "067"], "新北市": ["069", "071"], "臺中市": ["073", "075"], "臺南市": ["077", "079"],
  "連江縣": ["081", "083"], "金門縣": ["085", "087"]
};

const status = { started: new Date().toISOString(), cwaKey: !!CWA, moenvKey: !!MOENV, errors: [], counties: {}, seen: {} };
const scrub = s => { let t = String(s).split(CWA || "\u0000").join("***").split(MOENV || "\u0000").join("***"); if (PUSH_TOKEN.length >= 8) t = t.split(PUSH_TOKEN).join("***"); try { const c = JSON.parse(PUSH); for (const v of [c.priv, c.sub && c.sub.endpoint, c.sub && c.sub.keys && c.sub.keys.auth]) if (v && String(v).length >= 8) t = t.split(v).join("***"); } catch (e) {} return t; };
const fail = (where, e) => { status.errors.push(where + ": " + scrub(e && e.message || e).slice(0, 300)); };

// 不分大小寫取欄位，氣象署改過幾次欄位大小寫
const lvl = v => { const m = String(v || "").match(/(\d)\s*級?\s*(弱|強)?/); return m ? Number(m[1]) + (m[2] === "強" ? .5 : 0) : 0; };
const ci = (o, ...names) => {
  if (!o || typeof o !== "object") return undefined;
  const keys = Object.keys(o);
  for (const n of names) { const k = keys.find(k => k.toLowerCase() === n.toLowerCase()); if (k !== undefined) return o[k]; }
  return undefined;
};
const num = v => {
  if (v === "" || v == null) return null;
  const n = Number(v);
  return Number.isNaN(n) || n <= -90 ? null : n;
};
const arr = v => Array.isArray(v) ? v : v == null ? [] : [v];

async function getJSON(url, opt = {}) {
  let last;
  const tries = typeof opt === "number" ? opt : opt.tries || 3, o = typeof opt === "object" ? opt : {};
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { method: o.method || "GET", body: o.body, signal: AbortSignal.timeout(60000), headers: { accept: "application/json", ...(o.headers || {}) } });
      if (!r.ok) throw new Error("HTTP " + r.status + " " + (await r.text()).slice(0, 200));
      return await r.json();
    } catch (e) { last = e; await new Promise(r => setTimeout(r, 1500 * (i + 1))); }
  }
  throw last;
}
const cwaUrl = id => "https://opendata.cwa.gov.tw/api/v1/rest/datastore/" + id + "?Authorization=" + encodeURIComponent(CWA) + "&format=JSON";

function locations(json) {
  const L = ci(ci(json, "records"), "Locations");
  return arr(ci(arr(L)[0], "Location"));
}
// 把一個鄉鎮所有氣象因子依時間合併：[[時間, {Temperature:.., Weather:..}], ...]
function timeline(loc, tag) {
  const map = new Map();
  for (const el of arr(ci(loc, "WeatherElement"))) {
    for (const t of arr(ci(el, "Time"))) {
      const key = ci(t, "DataTime", "StartTime");
      if (!key) continue;
      const o = map.get(key) || {};
      for (const ev of arr(ci(t, "ElementValue"))) Object.assign(o, ev);
      map.set(key, o);
    }
  }
  const list = [...map.entries()].sort((a, b) => Date.parse(a[0]) - Date.parse(b[0]));
  if (!status.seen[tag] && list.length) {
    status.seen[tag] = { elements: arr(ci(loc, "WeatherElement")).map(e => ci(e, "ElementName")), keys: [...new Set(list.flatMap(x => Object.keys(x[1])))], firstTime: list[0][0], count: list.length };
  }
  return list;
}
function hourly(loc) {
  const now = Date.now();
  let pop = null, wc = null, wx = null, rh = null, ws = null;
  const rows = [];
  for (const [t, v] of timeline(loc, "3day")) {
    const p = ci(v, "ProbabilityOfPrecipitation"); if (p !== undefined && num(p) !== null) pop = num(p);
    const c = ci(v, "WeatherCode"); if (c !== undefined) { wc = String(c); wx = ci(v, "Weather") || wx; }
    const r1 = num(ci(v, "RelativeHumidity")); if (r1 !== null) rh = r1;
    const w1 = num(ci(v, "WindSpeed")); if (w1 !== null) ws = w1;
    const temp = num(ci(v, "Temperature"));
    if (temp === null) continue;
    const ms = Date.parse(t);
    if (ms < now - 4 * 3600e3 || ms > now + 76 * 3600e3) continue;
    rows.push([t, temp, num(ci(v, "ApparentTemperature")), pop, wc, wx, rh, ws]);
  }
  // 開頭幾筆如果還沒遇到降雨機率或天氣現象，往後借第一筆有值的
  const firstPop = rows.find(r => r[3] !== null), firstWx = rows.find(r => r[4] !== null);
  for (const r of rows) {
    if (r[3] === null && firstPop) r[3] = firstPop[3];
    if (r[4] === null && firstWx) { r[4] = firstWx[4]; r[5] = firstWx[5]; }
  }
  return rows;
}
function daily(loc) {
  const days = new Map();
  for (const [t, v] of timeline(loc, "week")) {
    const date = t.slice(0, 10), hour = Number(t.slice(11, 13));
    const d = days.get(date) || { hi: null, lo: null, pop: null, wc: null, uvi: null };
    const hi = num(ci(v, "MaxTemperature")), lo = num(ci(v, "MinTemperature")), pop = num(ci(v, "ProbabilityOfPrecipitation")), uvi = num(ci(v, "UVIndex"));
    if (hi !== null) d.hi = d.hi === null ? hi : Math.max(d.hi, hi);
    if (lo !== null) d.lo = d.lo === null ? lo : Math.min(d.lo, lo);
    if (pop !== null) d.pop = d.pop === null ? pop : Math.max(d.pop, pop);
    if (uvi !== null) d.uvi = d.uvi === null ? uvi : Math.max(d.uvi, uvi);
    const c = ci(v, "WeatherCode");
    if (c !== undefined && (d.wc === null || (hour >= 5 && hour <= 7))) d.wc = String(c);
    days.set(date, d);
  }
  return [...days.entries()].sort().map(([date, d]) => [date, d.hi, d.lo, d.wc, d.pop, d.uvi]);
}

function stations(json) {
  return arr(ci(ci(json, "records"), "Station")).map(s => {
    const geo = ci(s, "GeoInfo"), we = ci(s, "WeatherElement"), cs = arr(ci(geo, "Coordinates"));
    const co = cs.find(c => /WGS84/i.test(ci(c, "CoordinateName") || "")) || cs[0];
    return {
      station: ci(s, "StationName"), time: ci(ci(s, "ObsTime"), "DateTime"),
      county: ci(geo, "CountyName"), town: ci(geo, "TownName"),
      lat: num(ci(co, "StationLatitude")), lon: num(ci(co, "StationLongitude")),
      temp: num(ci(we, "AirTemperature")), rh: num(ci(we, "RelativeHumidity")),
      ws: num(ci(we, "WindSpeed")), wd: num(ci(we, "WindDirection")), rain: num(ci(ci(we, "Now"), "Precipitation")),
      uv: num(ci(we, "UVIndex")),
      hi: num(ci(ci(ci(ci(we, "DailyExtreme"), "DailyHigh"), "TemperatureInfo"), "AirTemperature")),
      lo: num(ci(ci(ci(ci(we, "DailyExtreme"), "DailyLow"), "TemperatureInfo"), "AirTemperature")),
      syn: false
    };
  }).filter(s => s.temp !== null && s.lat !== null && s.lon !== null);
}
const km = (a, b, c, d) => {
  const r = Math.PI / 180, x = (d - b) * r * Math.cos((a + c) / 2 * r), y = (c - a) * r;
  return Math.sqrt(x * x + y * y) * 6371;
};
function nearest(list, lat, lon, county, town) {
  if (lat === null || lon === null || !list.length) return null;
  const pools = [list.filter(s => s.county === county && s.town === town), list.filter(s => s.county === county), list];
  for (const pool of pools) {
    let best = null, bd = Infinity;
    for (const s of pool) { const d = km(lat, lon, s.lat, s.lon); if (d < bd) { bd = d; best = s; } }
    if (best && (pool !== pools[2] || bd < 60)) return { ...best, km: Math.round(bd * 10) / 10 };
  }
  return null;
}

async function main() {
  await mkdir(OUT, { recursive: true });
  const towns = {}, townData = {};
  // 歷史：從上一版網站讀回來，再接上這次的觀測（每小時一筆，留 26 小时）
  const site = process.env.SITE_URL || (process.env.GITHUB_REPOSITORY ? "https://" + process.env.GITHUB_REPOSITORY.split("/")[0].toLowerCase() + ".github.io/" + process.env.GITHUB_REPOSITORY.split("/")[1] + "/" : "");
  let hist = {};
  if (site) {
    try {
      const r = await fetch(site + "data/hist.json?t=" + Date.now(), { signal: AbortSignal.timeout(30000), cache: "no-store" });
      if (r.ok) hist = await r.json(); else if (r.status !== 404) throw new Error("HTTP " + r.status);
      status.seen.histTowns = Object.keys(hist).length;
    } catch (e) { fail("讀取歷史", e); }
  }
  const nowHour = Math.floor(Date.now() / 3600e3);
  const addHist = (key, temp, rain, aqi) => {
    const list = (hist[key] || []).filter(x => x[0] > nowHour - 26 && x[0] !== nowHour);
    list.push([nowHour, temp, rain, aqi]);
    hist[key] = list;
    return list;
  };
  if (!CWA) { fail("設定", "沒有 CWA_KEY，請到專案 Settings → Secrets and variables → Actions 新增"); }

  // 觀測
  let obs = [];
  if (CWA) {
    for (const id of ["O-A0003-001", "O-A0001-001"]) {
      try { const list = stations(await getJSON(cwaUrl(id))); if (id === "O-A0003-001") list.forEach(x => { x.syn = true; }); status.seen[id] = list.length; obs = obs.concat(list); }
      catch (e) { fail("觀測 " + id, e); }
    }
  }
  // 空氣品質
  let air = [];
  if (MOENV) {
    try {
      const j = await getJSON("https://data.moenv.gov.tw/api/v2/aqx_p_432?api_key=" + encodeURIComponent(MOENV) + "&limit=1000&format=JSON");
      air = arr(Array.isArray(j) ? j : ci(j, "records")).map(r => ({
        site: ci(r, "sitename"), county: ci(r, "county"), town: null, time: ci(r, "publishtime"),
        lat: num(ci(r, "latitude")), lon: num(ci(r, "longitude")),
        aqi: num(ci(r, "aqi")), status: ci(r, "status"), pm25: num(ci(r, "pm2.5")), pm10: num(ci(r, "pm10")),
        o3: num(ci(r, "o3")), no2: num(ci(r, "no2")), so2: num(ci(r, "so2")), co: num(ci(r, "co"))
      })).filter(s => s.aqi !== null && s.lat !== null);
      status.seen.aqi = air.length;
    } catch (e) { fail("空氣品質", e); }
  } else { fail("設定", "沒有 MOENV_KEY，空氣品質會顯示讀不到"); }

  // 鄉鎮預報：一次處理 4 個縣市
  const names = Object.keys(IDS);
  async function county(name) {
    const [d3, d7] = IDS[name];
    try {
      const [a, b] = await Promise.all([getJSON(cwaUrl("F-D0047-" + d3)), getJSON(cwaUrl("F-D0047-" + d7))]);
      const weekBy = new Map(locations(b).map(l => [ci(l, "LocationName"), l]));
      const out = {};
      for (const loc of locations(a)) {
        const town = ci(loc, "LocationName"), lat = num(ci(loc, "Latitude")), lon = num(ci(loc, "Longitude"));
        const f = hourly(loc), w = weekBy.has(town) ? daily(weekBy.get(town)) : [];
        if (!town || !f.length) continue;
        const o = nearest(obs, lat, lon, name, town), q = nearest(air, lat, lon, name, null);
        const h = addHist(name + "|" + town, o ? o.temp : null, o ? o.rain : null, q ? q.aqi : null);
        out[town] = {
          lat, lon, f, w, h,
          o: o && { station: o.station, time: o.time, temp: o.temp, rh: o.rh, rain: o.rain, ws: o.ws, wd: o.wd, km: o.km },
          a: q && { site: q.site, time: q.time, aqi: q.aqi, status: q.status, pm25: q.pm25, pm10: q.pm10, o3: q.o3, no2: q.no2, so2: q.so2, co: q.co, km: q.km }
        };
      }
      const list = Object.keys(out);
      status.counties[name] = list.length;
      if (!list.length) throw new Error("沒有解析出任何鄉鎮");
      towns[name] = list;
      for (const t of list) townData[name + "|" + t] = out[t];
      await writeFile(OUT + "/" + d3 + ".json", JSON.stringify({ county: name, updated: new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 19) + "+08:00", towns: out }));
    } catch (e) { fail("預報 " + name, e); }
  }
  if (CWA) for (let i = 0; i < names.length; i += 4) await Promise.all(names.slice(i, i + 4).map(county));

  // 觀測圖：先問檔案 API 拿圖檔位址，再把圖縮小存成網站自己的檔案
  const findUrl = (o, re) => {
    if (typeof o === "string") return re.test(o) ? o : null;
    if (o && typeof o === "object") for (const k in o) { const u = findUrl(o[k], re); if (u) return u; }
    return null;
  };
  const findKey = (o, re) => {
    if (o && typeof o === "object") for (const k in o) {
      if (re.test(k) && typeof o[k] === "string") return o[k];
      const t = findKey(o[k], re); if (t) return t;
    }
    return null;
  };
  const range = v => { const m = String(v || "").match(/(-?[\d.]+)\s*-\s*(-?[\d.]+)/); return m ? [Number(m[1]), Number(m[2])] : null; };
  const fileapi = id => getJSON("https://opendata.cwa.gov.tw/fileapi/v1/opendataapi/" + id + "?Authorization=" + encodeURIComponent(CWA) + "&downloadType=WEB&format=JSON");
  let magick = null;
  for (const c of ["magick", "convert"]) { try { execFileSync(c, ["-version"], { stdio: "ignore" }); magick = c; break; } catch (e) {} }
  status.magick = magick;
  const maps = {};
  let radarBuf = null;
  const IMG = /^https?:\/\/\S+\.(jpe?g|png)(\?\S*)?$/i;
  const MAPS = [
    ["radar", ["O-A0058-004", "O-A0058-003"]], ["ir", ["O-C0042-002"]], ["vis", ["O-C0042-008"]],
    ["rain", ["O-A0040-002", "O-A0040-001"]], ["temp", ["O-A0038-001"]]
  ];
  if (CWA) for (const [key, ids] of MAPS) {
    for (const id of ids) {
      try {
        const j = await fileapi(id), u = findUrl(j, IMG);
        if (!u) throw new Error("找不到圖檔位址");
        const r = await fetch(u, { signal: AbortSignal.timeout(90000) });
        if (!r.ok) throw new Error("HTTP " + r.status);
        const buf = Buffer.from(await r.arrayBuffer());
        if (buf.length < 5000) throw new Error("圖檔太小");
        const raw = OUT + "/raw-" + key + (/\.png/i.test(u) ? ".png" : ".jpg"), file = "map-" + key + ".jpg";
        await writeFile(raw, buf);
        if (key === "radar" && /\.png/i.test(u)) radarBuf = buf;
        let size = null;
        if (magick) {
          try {
            execFileSync(magick, [raw, "-resize", "1080x1080>", "-quality", "82", OUT + "/" + file]);
            size = execFileSync(magick === "magick" ? "magick" : "identify", (magick === "magick" ? ["identify"] : []).concat(["-format", "%w %h", OUT + "/" + file])).toString().split(" ").map(Number);
          } catch (e) { size = null; }
        }
        if (!size) { await writeFile(OUT + "/" + file.replace(".jpg", raw.slice(-4)), buf); }
        await unlink(raw);
        maps[key] = { file: size ? file : file.replace(".jpg", raw.slice(-4)), id, time: findKey(j, /^(datetime|obstime|date)$/i), lon: range(findKey(j, /^longituderange$/i)), lat: range(findKey(j, /^latituderange$/i)) };
        status.seen["map-" + key] = id + " " + buf.length;
        break;
      } catch (e) { fail("觀測圖 " + id, e); }
    }
  }
  await writeFile(OUT + "/maps.json", JSON.stringify(maps));
  if (CWA && process.env.SAT_DIAG) {
    const out = {};
    for (let n = 1; n <= 16; n++) {
      const id = "O-C0042-" + String(n).padStart(3, "0");
      try {
        const j = await fileapi(id), u = findUrl(j, IMG);
        let size = null, type = null;
        if (u) { const h = await fetch(u, { method: "HEAD", signal: AbortSignal.timeout(20000) }); size = h.headers.get("content-length"); type = h.headers.get("content-type"); }
        out[id] = { name: findKey(j, /^(datasetdescription|description|title|name)$/i), time: findKey(j, /^(datetime|obstime|date)$/i), u: u ? u.replace(/Authorization=[^&]+/, "") : null, size, type, lon: findKey(j, /^longituderange$/i), lat: findKey(j, /^latituderange$/i) };
      } catch (e) { out[id] = String(e.message || e).slice(0, 80); }
    }
    status.seen.satDiag = out;
  }

  // 閃電：過去 1 小時的閃電位置（KMZ 壓縮檔）
  const light = { time: null, pts: [], ok: false };
  if (CWA) {
    try {
      const r = await fetch("https://opendata.cwa.gov.tw/fileapi/v1/opendataapi/O-A0039-001?Authorization=" + encodeURIComponent(CWA) + "&downloadType=WEB&format=KMZ", { signal: AbortSignal.timeout(60000) });
      if (!r.ok) throw new Error("HTTP " + r.status);
      const buf = Buffer.from(await r.arrayBuffer()), tmp = OUT + "/tmp-light";
      let kml;
      if (buf[0] === 0x50 && buf[1] === 0x4b) { await writeFile(tmp, buf); kml = execFileSync("unzip", ["-p", tmp], { maxBuffer: 64 << 20 }).toString("utf8"); await unlink(tmp); }
      else kml = buf.toString("utf8");
      for (const m of kml.matchAll(/<Placemark[\s\S]*?<\/Placemark>/gi)) {
        const c = m[0].match(/<coordinates>\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)/i);
        if (c) light.pts.push([Number(c[1]), Number(c[2]), /對地|ground/i.test(m[0]) ? 1 : 0]);
      }
      light.time = new Date().toISOString(); light.ok = true;
      status.seen.lightning = light.pts.length;
    } catch (e) { light.pts = null; fail("閃電", e); }
  }
  if (!light.ok) light.pts = null;
  await writeFile(OUT + "/lightning.json", JSON.stringify(light));

  // 紫外線（綜觀站）與今日排行
  if (obs.length) {
    const uniq = new Map(); obs.forEach(x => { if (!uniq.has(x.station)) uniq.set(x.station, x); });
    const all = [...uniq.values()], pick = x => [x.station, x.county || "", x.town || ""];
    const top = (key, dir, n = 5) => all.filter(x => x[key] !== null && x[key] > -50).sort((a, b) => dir * (b[key] - a[key])).slice(0, n).map(x => pick(x).concat(x[key]));
    await writeFile(OUT + "/obs.json", JSON.stringify({
      time: (all.find(x => x.syn) || all[0]).time,
      uv: all.filter(x => x.syn && x.uv !== null && x.uv >= 0).map(x => pick(x).concat(x.uv, x.lat, x.lon)),
      hi: top("hi", 1), lo: top("lo", -1), rain: top("rain", 1).filter(x => x[3] > 0)
    }));
  }


  await writeFile(OUT + "/hist.json", JSON.stringify(hist));

  // 天氣警特報（各縣市）
  const warn = {};
  if (CWA) {
    try {
      const j = await getJSON(cwaUrl("W-C0033-001"));
      const walk = o => {
        if (Array.isArray(o)) { o.forEach(walk); return; }
        if (!o || typeof o !== "object") return;
        const name = ci(o, "locationName"), hc = ci(o, "hazardConditions");
        if (name && hc !== undefined) {
          const list = arr(ci(hc, "hazards")).map(z => {
            const info = ci(z, "info") || {}, vt = ci(z, "validTime") || {};
            const ph = ci(info, "phenomena"), sig = ci(info, "significance");
            return ph ? { name: ph + (sig || ""), start: ci(vt, "startTime") || null, end: ci(vt, "endTime") || null } : null;
          }).filter(Boolean);
          if (list.length) warn[name] = list;
          status.seen.warnLocations = (status.seen.warnLocations || 0) + 1;
          return;
        }
        for (const k in o) walk(o[k]);
      };
      walk(j);
      if (!status.seen.warnLocations) status.seen.warnKeys = Object.keys(ci(j, "records") || j).slice(0, 10);
    } catch (e) { fail("警特報", e); }
  }
  await writeFile(OUT + "/warn.json", JSON.stringify({ time: new Date().toISOString(), warn }));

  // ---------- 地震報告（顯著有感＋小區域，最近 10 筆）----------
  const shape = (o, depth = 0) => {
    if (depth > 5) return "…";
    if (Array.isArray(o)) return o.length ? [shape(o[0], depth + 1), "×" + o.length] : [];
    if (o && typeof o === "object") { const r = {}; for (const k of Object.keys(o).slice(0, 25)) r[k] = shape(o[k], depth + 1); return r; }
    return typeof o === "string" ? o.slice(0, 40) : o;
  };
  const quakes = [];
  if (CWA) for (const id of ["E-A0015-001", "E-A0016-001"]) {
    try {
      const j = await getJSON(cwaUrl(id));
      const list = arr(ci(ci(j, "records"), "Earthquake"));
      if (!status.seen.quakeShape && list[0]) status.seen.quakeShape = shape(list[0]);
      for (const q of list.slice(0, 8)) {
        const info = ci(q, "EarthquakeInfo") || {}, ep = ci(info, "Epicenter") || {}, mg = ci(info, "EarthquakeMagnitude") || {};
        const counties = {}, stations = [];
        for (const a of arr(ci(ci(q, "Intensity"), "ShakingArea"))) {
          const cn = ci(a, "CountyName"), ai = ci(a, "AreaIntensity");
          if (cn && ai) for (const c of String(cn).split(/[、,，\s]+/).filter(Boolean)) if (!counties[c] || lvl(ai) > lvl(counties[c])) counties[c] = String(ai);
          for (const s of arr(ci(a, "EqStation"))) {
            const si = ci(s, "SeismicIntensity"), la = num(ci(s, "StationLatitude")), lo = num(ci(s, "StationLongitude"));
            if (si && la !== null && lo !== null) stations.push([ci(s, "StationName") || "", la, lo, String(si)]);
          }
        }
        quakes.push({
          no: ci(q, "EarthquakeNo"), src: id, time: ci(info, "OriginTime"), depth: num(ci(info, "FocalDepth")),
          loc: ci(ep, "Location"), lat: num(ci(ep, "EpicenterLatitude")), lon: num(ci(ep, "EpicenterLongitude")),
          mag: num(ci(mg, "MagnitudeValue")), img: ci(q, "ReportImageURI") || null, web: ci(q, "Web") || null,
          text: ci(q, "ReportContent") || "", counties, stations
        });
      }
      status.seen[id] = list.length;
    } catch (e) { fail("地震 " + id, e); }
  }
  const qt = v => { const t = String(v || ""); return Date.parse(/[+-]\d\d:?\d\d$|Z$/.test(t) ? t : t.replace(" ", "T") + "+08:00"); };
  quakes.sort((a, b) => qt(b.time) - qt(a.time));
  await writeFile(OUT + "/quake.json", JSON.stringify({ list: quakes.slice(0, 10) }));

  // ---------- 颱風路徑（有颱風時才有資料）----------
  const typhoons = [];
  if (CWA) {
    try {
      const j = await getJSON(cwaUrl("W-C0034-005"));
      status.seen.typhoonShape = shape(ci(j, "records"));
      const coord = v => { const m = String(v || "").match(/(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)/); if (!m) return null; let a = Number(m[1]), b = Number(m[2]); return a < b ? { lat: a, lon: b } : { lon: a, lat: b }; };
      const radius = o => { if (o == null) return null; if (typeof o !== "object") return num(o); return num(ci(o, "Radius", "radius")) ?? null; };
      const fixOf = f => {
        let lat = num(ci(f, "CoordinateLatitude")), lon = num(ci(f, "CoordinateLongitude"));
        if (lat === null || lon === null) { const c = coord(ci(f, "coordinate")); if (!c) return null; lat = c.lat; lon = c.lon; }
        let t = ci(f, "DateTime", "fixTime");
        const init = ci(f, "InitialTime", "initTime"), tau = num(ci(f, "ForecastHour", "tau"));
        if (!t && init && tau !== null) t = new Date(Date.parse(init) + tau * 3600e3).toISOString();
        return { t, lat, lon, wind: num(ci(f, "MaxWindSpeed")), gust: num(ci(f, "MaxGustSpeed")), p: num(ci(f, "Pressure")),
          spd: num(ci(f, "MovingSpeed")), dir: ci(f, "MovingDirection") || null,
          r7: radius(ci(f, "Circle15ms", "circleOf15Ms")), r10: radius(ci(f, "Circle25ms", "circleOf25Ms")), prob: num(ci(f, "Radius70PercentProbability", "radiusOf70PercentProbability")) };
      };
      const tcs = arr(ci(ci(ci(j, "records"), "tropicalCyclones"), "tropicalCyclone"));
      if (tcs[0]) {
        const fa = arr(ci(ci(tcs[0], "analysisData"), "fix")), ff = arr(ci(ci(tcs[0], "forecastData"), "fix"));
        status.seen.typhoonFix = { a: fa.length, aLast: fa[fa.length - 1] || null, f: ff.length, f0: ff[0] || null };
      }
      for (const tc of tcs) {
        const past = arr(ci(ci(tc, "analysisData"), "fix")).map(f => fixOf(f)).filter(Boolean);
        const fc = arr(ci(ci(tc, "forecastData"), "fix")).map(f => fixOf(f)).filter(Boolean);
        if (past.length || fc.length) typhoons.push({ name: ci(tc, "cwaTyphoonName") || ci(tc, "typhoonName") || "熱帶性低氣壓", en: ci(tc, "typhoonName") || "", no: ci(tc, "cwaTdNo", "cwaTyNo") || null, past, fc });
      }
      status.seen.typhoons = typhoons.length;
    } catch (e) { fail("颱風", e); }
  }
  await writeFile(OUT + "/typhoon.json", JSON.stringify({ list: typhoons }));

  // ---------- 雷達動畫：每次存一張縮小的雷達圖，保留最近 2 小時 ----------
  const libs = {};
  for (const [k, m] of [["png", "pngjs"], ["jpeg", "jpeg-js"], ["push", "web-push"]]) {
    try { const x = await import(m); libs[k] = x.default || x; } catch (e) { status.seen["lib-" + m] = "missing"; }
  }
  const radarFrames = { frames: [] };
  try {
    let prev = { frames: [] };
    if (site) { try { const r = await fetch(site + "data/radar.json?t=" + Date.now(), { signal: AbortSignal.timeout(20000) }); if (r.ok) prev = await r.json(); } catch (e) {} }
    await mkdir(OUT + "/radar", { recursive: true });
    const keep = [];
    const newest = maps.radar && maps.radar.time ? Date.parse(maps.radar.time) : Date.now();
    for (const f of prev.frames || []) {
      if (!f || !f.file || !f.time || newest - Date.parse(f.time) > 125 * 60e3) continue;
      if (maps.radar && f.time === maps.radar.time) continue;
      try {
        const r = await fetch(site + "data/" + f.file, { signal: AbortSignal.timeout(20000) });
        if (!r.ok) continue;
        await writeFile(OUT + "/" + f.file, Buffer.from(await r.arrayBuffer()));
        keep.push(f);
      } catch (e) {}
    }
    if (radarBuf && libs.png && libs.jpeg && maps.radar) {
      const src = libs.png.PNG.sync.read(radarBuf), S = 4, w = Math.floor(src.width / S), h = Math.floor(src.height / S);
      const out = Buffer.alloc(w * h * 4);
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        let r = 0, g = 0, b = 0;
        for (let dy = 0; dy < S; dy++) for (let dx = 0; dx < S; dx++) {
          const i = ((y * S + dy) * src.width + x * S + dx) * 4, a = src.data[i + 3] / 255;
          r += src.data[i] * a + 255 * (1 - a); g += src.data[i + 1] * a + 255 * (1 - a); b += src.data[i + 2] * a + 255 * (1 - a);
        }
        const o = (y * w + x) * 4, n = S * S;
        out[o] = r / n; out[o + 1] = g / n; out[o + 2] = b / n; out[o + 3] = 255;
      }
      const t = maps.radar.time || new Date().toISOString(), name = "radar/r-" + Math.floor(Date.parse(t) / 60e3) + ".jpg";
      await writeFile(OUT + "/" + name, libs.jpeg.encode({ data: out, width: w, height: h }, 78).data);
      keep.push({ file: name, time: t });
    }
    keep.sort((a, b) => Date.parse(a.time) - Date.parse(b.time));
    radarFrames.frames = keep.slice(-13);
    status.seen.radarFrames = radarFrames.frames.length;
  } catch (e) { fail("雷達動畫", e); }
  await writeFile(OUT + "/radar.json", JSON.stringify(radarFrames));

  // ---------- 下雨通知（登記處名單 + 舊版個人訂閱碼）----------
  const subs = [];
  if (PUSH_API && PUSH_TOKEN) {
    try {
      const L = await getJSON(PUSH_API.replace(/\/+$/, "") + "/list", { headers: { Authorization: "Bearer " + PUSH_TOKEN } });
      for (const x of L.subs || []) subs.push({ id: x.id, sub: x.sub, places: x.places || [], pub: L.vapid.pub, priv: L.vapid.priv, remote: true });
      status.seen.pushList = (L.subs || []).length;
    } catch (e) { fail("下雨通知名單", e); }
  }
  if (PUSH) {
    try { const c = JSON.parse(PUSH); subs.push({ id: "personal", sub: c.sub, places: c.places || [], pub: c.pub, priv: c.priv }); }
    catch (e) { fail("下雨通知", "PUSH_SUB 不是正確的訂閱碼，請重新複製"); }
  }
  if (subs.length && !libs.push) fail("下雨通知", "缺少 web-push 套件");
  if (subs.length && libs.push) {
    try {
      const hash = s => createHash("sha1").update(String(s)).digest("hex").slice(0, 12);
      let state = { sent: {}, hello: {} };
      if (site) { try { const r = await fetch(site + "data/push-state.json?t=" + Date.now(), { signal: AbortSignal.timeout(20000) }); if (r.ok) state = await r.json(); } catch (e) {} }
      state.sent = state.sent || {}; if (!state.hello || typeof state.hello !== "object") state.hello = {};
      const now = Date.now(), twH = new Date(now + 8 * 3600e3).getUTCHours(), quiet = twH >= 22 || twH < 7;
      for (const k in state.sent) if (now - state.sent[k] > 30 * 3600e3) delete state.sent[k];

      // 雷達格點（每次只抓一份，大家共用）
      let grid = null;
      try {
        const j = await fileapi("O-A0059-001");
        const strs = [];
        const walk = o => { if (typeof o === "string" && o.length > 100000) strs.push(o); else if (o && typeof o === "object") for (const k in o) walk(o[k]); };
        walk(j);
        const pick = re => { const v = findKey(j, re); return v == null ? null : Number(v); };
        const content = strs.sort((a, b) => b.length - a.length)[0];
        if (content) {
          const v = content.split(/[\s,]+/).filter(Boolean).map(Number);
          const X = pick(/^griddimensionx$/i) || 921, Y = pick(/^griddimensiony$/i) || 881;
          const lon0 = pick(/^startpointlongitude$/i) || 115, lat0 = pick(/^startpointlatitude$/i) || 18, res = pick(/^gridresolution$/i) || 0.0125;
          if (v.length === X * Y) grid = { v, X, Y, lon0, lat0, res };
          status.seen.radarGrid = { n: v.length, X, Y, lon0, lat0, res, max: v.reduce((m, x) => x < 100 && x > m ? x : m, -999) };
        } else status.seen.radarGrid = "no content";
      } catch (e) { fail("雷達格點", e); }
      const echo = (lat, lon, km) => {
        if (!grid) return null;
        const { v, X, Y, lon0, lat0, res } = grid, dLat = km / 111, dLon = km / (111 * Math.cos(lat * Math.PI / 180));
        let m = -99;
        for (let y = Math.max(0, Math.floor((lat - dLat - lat0) / res)); y <= Math.min(Y - 1, Math.ceil((lat + dLat - lat0) / res)); y++)
          for (let x = Math.max(0, Math.floor((lon - dLon - lon0) / res)); x <= Math.min(X - 1, Math.ceil((lon + dLon - lon0) / res)); x++) {
            const val = v[y * X + x]; if (val > m && val < 100) m = val;
          }
        return m;
      };
      // 每個地點的提醒（同一地點只算一次）
      const cache = {};
      const alertsFor = p => {
        const key = p.c + "|" + p.t;
        if (cache[key]) return cache[key];
        const T = townData[key], out = [];
        if (T) {
          const name = p.t.length > 2 ? p.t.replace(/[區鄉鎮市]$/, "") : p.t;
          if (!quiet) {
            const e10 = echo(T.lat, T.lon, 10);
            if (e10 !== null && e10 >= 30) out.push({ k: "rd|" + key, cool: 3, text: `${name}附近 10 公里內有雨，衣服記得收` });
            const rows = (T.f || []).map(r => ({ ms: Date.parse(r[0]), p: r[3] })).filter(r => r.p != null);
            const cur = rows.filter(r => r.ms <= now).pop(), up = rows.find(r => r.ms > now && r.ms <= now + 3 * 3600e3 && r.p >= 70);
            if (up && (!cur || cur.p < 50)) out.push({ k: "fc|" + key + "|" + up.ms, cool: 24, text: `${name} ${new Date(up.ms + 8 * 3600e3).getUTCHours()} 點起降雨機率 ${up.p}%，有曬衣服記得收` });
          }
          for (const z of warn[p.c] || []) out.push({ k: "wn|" + p.c + "|" + z.name + "|" + z.end, cool: 24, text: `${p.c}發布${z.name}` });
        }
        return (cache[key] = out);
      };
      const dead = [];
      let sent = 0, failed = 0;
      const one = async s => {
        const sh = hash(s.id + "|" + (s.sub && s.sub.endpoint)), lines = [], keys = [];
        const seenText = new Set();
        for (const p of (s.places || []).slice(0, 8)) for (const a of alertsFor(p)) {
          const k = hash(sh + "|" + a.k);
          if (state.sent[k] && now - state.sent[k] < a.cool * 3600e3) continue;
          if (!seenText.has(a.text)) { lines.push(a.text); seenText.add(a.text); }
          keys.push(k);
        }
        const hello = state.hello[sh] !== 1;
        if (hello) lines.unshift("下雨通知開通了，之後快下雨會提醒你");
        if (!lines.length) return;
        try {
          await libs.push.sendNotification(s.sub, JSON.stringify({ title: "曬衣服嗎", body: lines.join("\n"), tag: "rain", url: site || "./" }),
            { TTL: 1800, urgency: "high", vapidDetails: { subject: site || "https://github.com", publicKey: s.pub, privateKey: s.priv } });
          keys.forEach(k => { state.sent[k] = now; });
          state.hello[sh] = 1; sent++;
        } catch (e) {
          failed++;
          if (e.statusCode === 404 || e.statusCode === 410) { if (s.remote) dead.push(s.id); else fail("下雨通知", "你的個人訂閱已失效，請在網頁重新開通"); delete state.hello[sh]; }
          else if (failed <= 3) fail("下雨通知", "傳送失敗 " + (e.statusCode || "") + " " + String(e.body || e.message || "").slice(0, 120));
        }
      };
      for (let i = 0; i < subs.length; i += 10) await Promise.all(subs.slice(i, i + 10).map(one));
      if (dead.length && PUSH_API) {
        try { await getJSON(PUSH_API.replace(/\/+$/, "") + "/prune", { method: "POST", headers: { Authorization: "Bearer " + PUSH_TOKEN, "Content-Type": "application/json" }, body: JSON.stringify({ ids: dead }) }); }
        catch (e) { fail("清除失效訂閱", e); }
      }
      status.seen.push = { subs: subs.length, sent, failed, removed: dead.length, quiet };
      await writeFile(OUT + "/push-state.json", JSON.stringify(state));
    } catch (e) { fail("下雨通知", e); }
  }

  status.totalTowns = Object.values(status.counties).reduce((a, b) => a + b, 0);
  status.finished = new Date().toISOString();
  if (Object.keys(towns).length) await writeFile(OUT + "/towns.json", JSON.stringify(towns));
  await writeFile(OUT + "/status.json", JSON.stringify(status, null, 1));
  console.log(scrub(JSON.stringify(status, null, 1)));
}
main().catch(async e => {
  fail("程式", e);
  try { await mkdir(OUT, { recursive: true }); await writeFile(OUT + "/status.json", JSON.stringify(status, null, 1)); } catch (x) {}
  console.log(scrub(JSON.stringify(status, null, 1)));
});
