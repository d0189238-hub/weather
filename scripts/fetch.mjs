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
// 氣象署定量降水預報圖的色階（每格的下限，毫米）與讀圖
const QPF_BINS = [[0.5, [195, 195, 195]], [1, [161, 255, 255]], [2, [3, 200, 255]], [5, [5, 155, 255]], [10, [3, 100, 255]], [15, [5, 155, 2]], [20, [58, 255, 3]], [30, [255, 253, 3]], [40, [255, 203, 0]], [50, [255, 150, 0]], [70, [255, 0, 0]], [90, [209, 0, 0]], [110, [155, 0, 0]], [130, [153, 0, 156]], [150, [207, 0, 210]], [200, [255, 0, 255]], [300, [255, 203, 255]]];
function qpfGrid(img, o) {
  const { width: W, height: H, data } = img;
  if (W !== 1245 || H !== 1500) return null;
  const px = (x, y) => { const i = (y * W + x) * 4; return [data[i], data[i + 1], data[i + 2]]; };
  // 版面檢查：外框黑線在 y=152、x=13
  const dk = (x, y) => { const c = px(x, y); return c[0] + c[1] + c[2] < 300; };
  if (!dk(600, 152) || !dk(13, 800) || !dk(600, 1488)) return null;
  // 經緯度 → 圖上位置（用本島四端點與澎湖、蘭嶼對過）
  const toX = lon => 380 + (lon - 120.035) * 366.1, toY = lat => 201 + (25.299 - lat) * 359.5;
  const cls = c => {
    if (c[0] >= 248 && c[1] >= 248 && c[2] >= 248) return 0;          // 陸地白色：沒雨
    if (Math.abs(c[0] - 237) + Math.abs(c[1] - 249) + Math.abs(c[2] - 254) < 8) return -1;   // 海
    let best = -2, bd = 40;
    QPF_BINS.forEach(([, k], i) => { const d = Math.abs(c[0] - k[0]) + Math.abs(c[1] - k[1]) + Math.abs(c[2] - k[2]); if (d < (i ? bd : Math.min(bd, 14))) { bd = d; best = i + 1; } });
    return best;   // -2：線條或文字
  };
  const cells = new Uint8Array(o.X * o.Y); let max = 0;
  for (let gy = 0; gy < o.Y; gy++) for (let gx = 0; gx < o.X; gx++) {
    const lon = o.lon0 + (gx + 0.5) * o.res, lat = o.lat0 + (gy + 0.5) * o.res;
    const x0 = Math.round(toX(lon)), y0 = Math.round(toY(lat));
    // 取附近像素裡最多的顏色（避開縣市界線與反鋸齒的灰邊）
    let v = -2;
    for (let r = 1; r <= 4 && v === -2; r++) {
      const cnt = {};
      for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
        const x = x0 + dx, y = y0 + dy; if (x < 16 || y < 155 || x > 1227 || y > 1485) continue;
        const c = cls(px(x, y)); if (c >= -1) cnt[c] = (cnt[c] || 0) + 1;
      }
      let bn = 0; for (const k in cnt) if (cnt[k] > bn || (cnt[k] === bn && Number(k) > v)) { bn = cnt[k]; v = Number(k); }
    }
    const val = v < 0 ? 0 : v;
    cells[gy * o.X + gx] = val; if (val > max) max = val;
  }
  return { cells, max };
}
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
// 氣象署天氣代碼：08–22、29–41 是有雨的天氣
const isRainCode = c => { const n = Number(c); return (n >= 8 && n <= 22) || (n >= 29 && n <= 41); };
function daily(loc) {
  const days = new Map();
  for (const [t, v] of timeline(loc, "week")) {
    const date = t.slice(0, 10), hour = Number(t.slice(11, 13));
    const d = days.get(date) || { hi: null, lo: null, pop: null, wc: null, uvi: null, wet: 0 };
    const hi = num(ci(v, "MaxTemperature")), lo = num(ci(v, "MinTemperature")), pop = num(ci(v, "ProbabilityOfPrecipitation")), uvi = num(ci(v, "UVIndex"));
    if (hi !== null) d.hi = d.hi === null ? hi : Math.max(d.hi, hi);
    if (lo !== null) d.lo = d.lo === null ? lo : Math.min(d.lo, lo);
    if (pop !== null) d.pop = d.pop === null ? pop : Math.max(d.pop, pop);
    if (uvi !== null) d.uvi = d.uvi === null ? uvi : Math.max(d.uvi, uvi);
    const c = ci(v, "WeatherCode");
    if (c !== undefined && (d.wc === null || (hour >= 5 && hour <= 7))) d.wc = String(c);
    if (c !== undefined && isRainCode(c)) d.wet |= hour >= 5 && hour < 17 ? 1 : 2;   // 1 白天有雨、2 晚上有雨
    days.set(date, d);
  }
  return [...days.entries()].sort().map(([date, d]) => [date, d.hi, d.lo, d.wc, d.pop, d.uvi, d.wet]);
}

function stations(json) {
  return arr(ci(ci(json, "records"), "Station")).map(s => {
    const geo = ci(s, "GeoInfo"), we = ci(s, "WeatherElement"), cs = arr(ci(geo, "Coordinates"));
    const co = cs.find(c => /WGS84/i.test(ci(c, "CoordinateName") || "")) || cs[0];
    return {
      station: ci(s, "StationName"), time: ci(ci(s, "ObsTime"), "DateTime"),
      county: ci(geo, "CountyName"), town: ci(geo, "TownName"),
      lat: num(ci(co, "StationLatitude")), lon: num(ci(co, "StationLongitude")), alt: num(ci(geo, "StationAltitude")),
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
  status.seen.mapBounds = Object.fromEntries(Object.entries(maps).map(([k, v]) => [k, [v.id, v.lon, v.lat]]));

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
      temps: all.filter(x => (x.syn || ["斗六", "埔里", "梧棲"].includes(x.station)) && x.temp !== null && x.temp > -30 && x.lat != null).map(x => [x.station, x.temp, x.lat, x.lon, x.county || ""]),
      tall: all.filter(x => x.temp !== null && x.temp > -30 && x.temp < 50 && x.lat != null && x.lon != null).map(x => [Math.round(x.lat * 1000) / 1000, Math.round(x.lon * 1000) / 1000, x.temp, x.alt == null ? null : Math.round(x.alt)]),
      hi: top("hi", 1), lo: top("lo", -1), rain: top("rain", 1).filter(x => x[3] > 0)
    }));
  }


  await writeFile(OUT + "/hist.json", JSON.stringify(hist));
  // 鄉鎮名稱位置（地圖標籤用）
  const tc = {};
  for (const k in townData) { const T = townData[k]; if (T && T.lat != null && T.lon != null) { const [c, t] = k.split("|"); (tc[c] = tc[c] || {})[t] = [Math.round(T.lat * 1000) / 1000, Math.round(T.lon * 1000) / 1000]; } }
  await writeFile(OUT + "/towncoords.json", JSON.stringify(tc));

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
  // 只留最近 5 天，不累積
  const qList = quakes.filter(q => Date.now() - qt(q.time) < 5 * 864e5);
  status.seen.quakeKept = qList.length;
  await writeFile(OUT + "/quake.json", JSON.stringify({ list: qList }));

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

  const libs = {};
  for (const [k, m] of [["png", "pngjs"], ["jpeg", "jpeg-js"], ["push", "web-push"]]) {
    try { const x = await import(m); libs[k] = x.default || x; } catch (e) { status.seen["lib-" + m] = "missing"; }
  }
  // ---------- 定量降水預報（氣象署 12 小時累積雨量圖 I～IV，讀圖上的顏色換回毫米）----------
  const qpfOut = { periods: [], lon0: 119.95, lat0: 21.87, res: 0.0125, X: 168, Y: 277, bins: QPF_BINS.map(b => b[0]) };
  if (CWA && libs.png) {
    for (const [n, id] of [[1, "F-C0035-015"], [2, "F-C0035-017"], [3, "F-C0035-023"], [4, "F-C0035-024"]]) {
      try {
        const j = await fileapi(id), u = findUrl(j, IMG), sent = findKey(j, /^sent$/i);
        if (!u || !sent) throw new Error("找不到圖檔");
        const r = await fetch(u, { signal: AbortSignal.timeout(60000) });
        if (!r.ok) throw new Error("HTTP " + r.status);
        const buf = Buffer.from(await r.arrayBuffer()), img = libs.png.PNG.sync.read(buf);
        const g = qpfGrid(img, qpfOut);
        if (!g) throw new Error("圖的版面跟預期不同 " + img.width + "x" + img.height);
        // 發布時間 → 第一段從 08 或 20 點開始，每段 12 小時
        const tw = new Date(Date.parse(sent) + 8 * 3600e3), hr = tw.getUTCHours();
        const base = Date.UTC(tw.getUTCFullYear(), tw.getUTCMonth(), tw.getUTCDate()) - 8 * 3600e3;
        const start0 = hr >= 3 && hr < 15 ? base + 8 * 3600e3 : hr >= 15 ? base + 20 * 3600e3 : base - 4 * 3600e3;
        const from = start0 + (n - 1) * 12 * 3600e3;
        await writeFile(OUT + "/qpf-" + n + ".png", buf);
        qpfOut.periods.push({ n, from: new Date(from).toISOString(), to: new Date(from + 12 * 3600e3).toISOString(), sent, img: "qpf-" + n + ".png", g: Buffer.from(g.cells).toString("base64"), max: g.max });
      } catch (e) { fail("雨量預報 " + id, e); }
    }
    status.seen.qpf = qpfOut.periods.map(p => p.n + ":" + p.max);
  }
  await writeFile(OUT + "/qpf.json", JSON.stringify(qpfOut));

  // ---------- 衛星雲圖動畫（氣象署官網高解析圖，最近 2 小時，每 10 分鐘一張）----------
  const satOut = {};
  try {
    let prev = {};
    if (site) { try { const r = await fetch(site + "data/sat.json?t=" + Date.now(), { signal: AbortSignal.timeout(20000) }); if (r.ok) prev = await r.json(); } catch (e) {} }
    await mkdir(OUT + "/sat", { recursive: true });
    const p2 = n => String(n).padStart(2, "0");
    const slotStr = ms => { const d = new Date(ms + 8 * 3600e3); return `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())}-${p2(d.getUTCHours())}-${p2(d.getUTCMinutes())}`; };
    const slotIso = ms => { const d = new Date(ms + 8 * 3600e3); return `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())}T${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}:00+08:00`; };
    const base = Math.floor(Date.now() / 600e3) * 600e3;
    const slots = []; for (let k = 15; k >= 1; k--) slots.push(base - k * 600e3);
    const shrink = buf => {
      if (!libs.jpeg) return buf;
      const src = libs.jpeg.decode(buf, { useTArray: true, maxMemoryUsageInMB: 1024 });
      const S = Math.max(1, Math.ceil(src.width / 920)), w = Math.floor(src.width / S), h = Math.floor(src.height / S), out = Buffer.alloc(w * h * 4);
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        let r = 0, g = 0, b = 0;
        for (let dy = 0; dy < S; dy++) for (let dx = 0; dx < S; dx++) { const i = ((y * S + dy) * src.width + x * S + dx) * 4; r += src.data[i]; g += src.data[i + 1]; b += src.data[i + 2]; }
        const o = (y * w + x) * 4, n = S * S; out[o] = r / n; out[o + 1] = g / n; out[o + 2] = b / n; out[o + 3] = 255;
      }
      return Buffer.from(libs.jpeg.encode({ data: out, width: w, height: h }, 74).data);
    };
    const cwa = (prod, t) => `https://www.cwa.gov.tw/Data/satellite/${prod}/${prod}-${t}.jpg`;
    for (const [key, small, full] of [["ir", "LCC_IR1_CR_1000", "LCC_IR1_CR_2750"], ["rgb", "LCC_TRGB_2750", "LCC_TRGB_2750"]]) {
      const have = {}; for (const f of (prev[key] && prev[key].frames) || []) have[f.time] = f;
      const frames = [];
      let made = 0;
      for (const ms of slots) {
        const iso = slotIso(ms), file = `sat/${key}-${Math.floor(ms / 60e3)}.jpg`;
        try {
          if (have[iso]) {
            const r = await fetch(site + "data/" + have[iso].file, { signal: AbortSignal.timeout(20000) });
            if (r.ok) { await writeFile(OUT + "/" + file, Buffer.from(await r.arrayBuffer())); frames.push({ file, time: iso }); continue; }
          }
          if (made >= 15) continue;
          const r = await fetch(cwa(small, slotStr(ms)), { signal: AbortSignal.timeout(30000) });
          if (!r.ok) continue;
          await writeFile(OUT + "/" + file, shrink(Buffer.from(await r.arrayBuffer())));
          frames.push({ file, time: iso }); made++;
        } catch (e) {}
      }
      const keep = frames.slice(-12);
      let fullFile = null;
      const last = keep[keep.length - 1];
      if (last) {
        try {
          const r = await fetch(cwa(full, slotStr(Date.parse(last.time))), { signal: AbortSignal.timeout(60000) });
          if (r.ok) { fullFile = `sat/${key}-full.jpg`; await writeFile(OUT + "/" + fullFile, Buffer.from(await r.arrayBuffer())); }
        } catch (e) {}
      }
      if (keep.length) satOut[key] = { frames: keep, full: fullFile ? { file: fullFile, time: last.time } : null };
      status.seen["sat-" + key] = keep.length + " frames, new " + made + (fullFile ? ", full" : "");
    }
  } catch (e) { fail("衛星雲圖", e); }
  await writeFile(OUT + "/sat.json", JSON.stringify(satOut));

  // ---------- 雷達動畫：每次存一張縮小的雷達圖，保留最近 2 小時 ----------
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

  // ---------- 地形高度（溫度圖用：山區依高度變涼、加上地形明暗）。只做一次，之後沿用網站上的檔案 ----------
  try {
    let dem = null;
    if (site) { try { const r = await fetch(site + "data/dem.json", { signal: AbortSignal.timeout(30000) }); if (r.ok) { const j = await r.json(); if (j && j.v === 2) dem = j; } } catch (e) {} }
    if (!dem && libs.png) {
      const Z = 10, N = 256 * 2 ** Z, G = { v: 2, lon0: 119.3, lat0: 21.85, res: 0.008, X: 350, Y: 438 };
      const gx = lon => (lon + 180) / 360 * N, gy = lat => { const r = lat * Math.PI / 180; return (1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * N; };
      const tiles = new Map(), need = new Set();
      const x0 = Math.floor(gx(G.lon0) / 256), x1 = Math.floor(gx(G.lon0 + G.X * G.res) / 256), y0 = Math.floor(gy(G.lat0 + G.Y * G.res) / 256), y1 = Math.floor(gy(G.lat0) / 256);
      for (let tx = x0; tx <= x1; tx++) for (let ty = y0; ty <= y1; ty++) need.add(tx + "/" + ty);
      await Promise.all([...need].map(async k => {
        const [tx, ty] = k.split("/");
        try { const r = await fetch(`https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${Z}/${tx}/${ty}.png`, { signal: AbortSignal.timeout(30000) }); if (r.ok) tiles.set(k, libs.png.PNG.sync.read(Buffer.from(await r.arrayBuffer()))); } catch (e) {}
      }));
      if (tiles.size >= need.size * 0.9) {
        const el = (px, py) => { const t = tiles.get(Math.floor(px / 256) + "/" + Math.floor(py / 256)); if (!t) return 0; const x = Math.floor(px) % 256, y = Math.floor(py) % 256, o = (y * 256 + x) * 4; return t.data[o] * 256 + t.data[o + 1] + t.data[o + 2] / 256 - 32768; };
        const out = new Int16Array(G.X * G.Y);
        for (let j = 0; j < G.Y; j++) for (let i = 0; i < G.X; i++) {
          const lon = G.lon0 + (i + 0.5) * G.res, lat = G.lat0 + (j + 0.5) * G.res, px = gx(lon), py = gy(lat);
          const a = el(px, py), b = el(px + 1, py), c = el(px, py + 1), d = el(px + 1, py + 1), fx = px % 1, fy = py % 1;
          out[j * G.X + i] = Math.max(-1, Math.round(a * (1 - fx) * (1 - fy) + b * fx * (1 - fy) + c * (1 - fx) * fy + d * fx * fy));
        }
        dem = { ...G, d: Buffer.from(out.buffer).toString("base64") };
        status.seen.demBuilt = { tiles: tiles.size, max: Math.max(...out) };
      } else status.seen.demBuilt = { tiles: tiles.size, need: need.size };
    }
    if (dem) await writeFile(OUT + "/dem.json", JSON.stringify(dem));
  } catch (e) { fail("地形高度", e); }

  // ---------- 全臺預報圖層：鄉鎮邊界＋逐 3 小時預報 ----------
  try {
    let topo = null;
    for (const u of ["https://cdn.jsdelivr.net/npm/taiwan-atlas/towns-10t.json", "https://unpkg.com/taiwan-atlas/towns-10t.json", site && site + "data/towns-topo.json"].filter(Boolean)) {
      try { const r = await fetch(u, { signal: AbortSignal.timeout(30000) }); if (r.ok) { const t = await r.text(); if (t.length > 50000 && t.includes('"Topology"')) { topo = t; status.seen.topoFrom = u.replace(/\?.*$/, ""); break; } } } catch (e) {}
    }
    if (topo) {
      await writeFile(OUT + "/towns-topo.json", topo);
      const tj = JSON.parse(topo), objs = Object.keys(tj.objects || {});
      const geoms = objs.length ? tj.objects[objs[0]].geometries || [] : [];
      const p0 = geoms[0] && geoms[0].properties || {};
      const keyOf = p => ((p.COUNTYNAME || p.county || "") + "|" + (p.TOWNNAME || p.town || "")).replace(/台/g, "臺");
      const matched = geoms.filter(g => townData[keyOf(g.properties || {})]).length;
      status.seen.topo = { objects: objs, n: geoms.length, props: Object.keys(p0), sample: p0, matched, bytes: topo.length,
        missing: geoms.filter(g => !townData[keyOf(g.properties || {})]).slice(0, 8).map(g => keyOf(g.properties || {})) };
    } else fail("鄉鎮邊界", "下載失敗");
    // 預報：從現在起每 3 小時一格，共 16 格（48 小時）
    const now3 = Math.ceil(Date.now() / 3 / 3600e3) * 3 * 3600e3;
    const times = []; for (let k = 0; k < 16; k++) times.push(now3 + k * 3 * 3600e3);
    const fc = { times: times.map(t => new Date(t).toISOString()), towns: {} };
    for (const k in townData) {
      const rows = (townData[k].f || []).map(r => [Date.parse(r[0]), r]).filter(x => !isNaN(x[0])).sort((a, b) => a[0] - b[0]);
      if (!rows.length) continue;
      fc.towns[k] = times.map(t => {
        let best = null; for (const x of rows) { if (x[0] <= t) best = x; else break; }
        if (!best || t - best[0] > 6 * 3600e3) return null;
        const r = best[1]; return [r[4] == null ? null : String(r[4]), r[3], r[1] == null ? null : Math.round(r[1])];
      });
    }
    await writeFile(OUT + "/fc.json", JSON.stringify(fc));
    status.seen.fcTowns = Object.keys(fc.towns).length;
  } catch (e) { fail("全臺預報圖層", e); }

  // ---------- 雷達格點：自己上色成透明雨區圖層（給互動地圖用）----------
  let grid = null;
  const rgridOut = { frames: [], bounds: null, flip: null };
  if (CWA) {
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
        const time = findKey(j, /^(datetime|obstime|date)$/i);
        if (v.length === X * Y) {
          // 排除異常：超過 75 dBZ 視為無效；整排幾乎都有值的格點列（資料雜訊）整排清掉
          let bad = 0;
          for (let i = 0; i < v.length; i++) if (v[i] >= 75) v[i] = -99;
          for (let y = 0; y < Y; y++) {
            let n = 0; for (let x = 0; x < X; x++) if (v[y * X + x] >= 10) n++;
            if (n > X * 0.6) { bad++; for (let x = 0; x < X; x++) v[y * X + x] = -99; }
          }
          for (let x = 0; x < X; x++) {
            let n = 0; for (let y = 0; y < Y; y++) if (v[y * X + x] >= 10) n++;
            if (n > Y * 0.6) { bad++; for (let y = 0; y < Y; y++) v[y * X + x] = -99; }
          }
          status.seen.gridBadLines = bad;
          grid = { v, X, Y, lon0, lat0, res, time, flip: false };
        }
        status.seen.radarGrid = { n: v.length, X, Y, lon0, lat0, res, time, max: v.reduce((m, x) => x < 100 && x > m ? x : m, -999) };
      } else status.seen.radarGrid = "no content";
    } catch (e) { fail("雷達格點", e); }
  }
  let prevG = {};
  if (site) { try { const r = await fetch(site + "data/rgrid.json?t=" + Date.now(), { signal: AbortSignal.timeout(20000) }); if (r.ok) prevG = await r.json(); } catch (e) {} }
  // 方向比對：把強回波格點分別用「由南往北」和「由北往南」投到氣象署雷達圖上，看哪個落在有顏色的地方
  if (grid && libs.png) {
    try {
      let img = null, lon = null, lat = null;
      try {
        const j3 = await fileapi("O-A0058-003"), u3 = findUrl(j3, IMG);
        if (u3) { const r = await fetch(u3, { signal: AbortSignal.timeout(60000) }); if (r.ok) { img = libs.png.PNG.sync.read(Buffer.from(await r.arrayBuffer())); lon = range(findKey(j3, /^longituderange$/i)); lat = range(findKey(j3, /^latituderange$/i)); } }
      } catch (e) {}
      if (!img && radarBuf && maps.radar) { img = libs.png.PNG.sync.read(radarBuf); lon = maps.radar.lon; lat = maps.radar.lat; }
      if (img && lon && lat) {
        const { v, X, Y, lon0, lat0, res } = grid;
        const colorful = (px, py) => {
          if (px < 0 || py < 0 || px >= img.width || py >= img.height) return 0;
          const i = (py * img.width + px) * 4, r = img.data[i], g = img.data[i + 1], b = img.data[i + 2], mx = Math.max(r, g, b), mn = Math.min(r, g, b);
          return mx > 80 && (mx - mn) / mx > 0.5 ? 1 : 0;
        };
        let a = 0, bb = 0, n = 0;
        for (let k = 0; k < v.length && n < 4000; k += 7) {
          if (!(v[k] >= 35 && v[k] < 100)) continue;
          const y = Math.floor(k / X), x = k % X, lo = lon0 + x * res;
          const latS = lat0 + y * res, latN = lat0 + (Y - 1 - y) * res;
          if (lo < lon[0] || lo > lon[1]) continue;
          const px = Math.round((lo - lon[0]) / (lon[1] - lon[0]) * (img.width - 1));
          const pyS = Math.round((lat[1] - latS) / (lat[1] - lat[0]) * (img.height - 1)), pyN = Math.round((lat[1] - latN) / (lat[1] - lat[0]) * (img.height - 1));
          a += colorful(px, pyS); bb += colorful(px, pyN); n++;
        }
        status.seen.gridCheck = { samples: n, southFirst: a, northFirst: bb };
        if (n >= 30 && Math.max(a, bb) >= n * 0.3 && Math.abs(a - bb) >= n * 0.15) rgridOut.flip = bb > a;
      }
    } catch (e) { fail("雷達方向比對", e); }
  }
  if (rgridOut.flip === null) rgridOut.flip = typeof prevG.flip === "boolean" ? prevG.flip : false;
  if (grid) grid.flip = rgridOut.flip;
  status.seen.gridFlip = rgridOut.flip;
  const gv = (x, y) => grid.v[(grid.flip ? grid.Y - 1 - y : y) * grid.X + x];
  // 上色（氣象署雷達色階），投影成 Web Mercator 的透明 PNG
  const makeOverlay = getVal => {
    if (!grid || !libs.png) return null;
    const { X, Y, lon0, lat0, res } = grid;
    const latS = lat0, latN = lat0 + (Y - 1) * res, lonW = lon0, lonE = lon0 + (X - 1) * res;
    const merc = la => Math.log(Math.tan(Math.PI / 4 + la * Math.PI / 360));
    const mS = merc(latS), mN = merc(latN), W = X, H = Math.round((mN - mS) / ((lonE - lonW) * Math.PI / 180) * (W - 1)) + 1;
    const COL = [[65, [255, 255, 255]], [60, [150, 0, 220]], [55, [230, 0, 255]], [50, [190, 0, 0]], [45, [255, 0, 0]], [40, [255, 128, 0]], [35, [255, 200, 0]], [30, [255, 255, 0]], [25, [0, 150, 0]], [20, [0, 200, 0]], [15, [0, 128, 255]], [10, [0, 200, 255]]];
    const png = new libs.png.PNG({ width: W, height: H });
    for (let py = 0; py < H; py++) {
      const m = mN - (mN - mS) * py / (H - 1), la = (2 * Math.atan(Math.exp(m)) - Math.PI / 2) * 180 / Math.PI;
      const gy = Math.round((la - lat0) / res);
      for (let px = 0; px < W; px++) {
        const o = (py * W + px) * 4;
        const val = gy >= 0 && gy < Y ? getVal(px, gy) : -99;
        const c = val >= 10 && val < 100 ? COL.find(z => val >= z[0]) : null;
        if (c) { png.data[o] = c[1][0]; png.data[o + 1] = c[1][1]; png.data[o + 2] = c[1][2]; png.data[o + 3] = 255; }
        else png.data[o + 3] = 0;
      }
    }
    return libs.png.PNG.sync.write(png);
  };
  try {
    await mkdir(OUT + "/rgrid", { recursive: true });
    const keep = [];
    const newest = grid && grid.time ? Date.parse(grid.time) : Date.now();
    for (const f of prevG.frames || []) {
      if (!f || !f.file || !f.time || newest - Date.parse(f.time) > 125 * 60e3 || (grid && f.time === grid.time)) continue;
      try { const r = await fetch(site + "data/" + f.file, { signal: AbortSignal.timeout(20000) }); if (r.ok) { await writeFile(OUT + "/" + f.file, Buffer.from(await r.arrayBuffer())); keep.push(f); } } catch (e) {}
    }
    if (grid && libs.png) {
      const { X, Y, lon0, lat0, res } = grid;
      const latS = lat0, latN = lat0 + (Y - 1) * res, lonW = lon0, lonE = lon0 + (X - 1) * res;
      const t = grid.time || new Date().toISOString(), name = "rgrid/g-" + Math.floor(Date.parse(t) / 60e3) + ".png";
      await writeFile(OUT + "/" + name, makeOverlay((px, gy) => gv(px, gy)));
      keep.push({ file: name, time: t });
      rgridOut.bounds = [[latS - res / 2, lonW - res / 2], [latN + res / 2, lonE + res / 2]];
    } else if (prevG.bounds) rgridOut.bounds = prevG.bounds;
    keep.sort((a, b) => Date.parse(a.time) - Date.parse(b.time));
    rgridOut.frames = keep.slice(-13);
    status.seen.rgridFrames = rgridOut.frames.length;
  } catch (e) { fail("雨區圖層", e); }
  await writeFile(OUT + "/rgrid.json", JSON.stringify(rgridOut));
  // ---------- 雨帶推估（外推法）：比對上一張雷達格點算移動方向與速度，往後推 30、60 分鐘 ----------
  const nowcast = { time: grid ? grid.time : null, frames: [], towns: {}, motion: null };
  try {
    if (grid) {
      const { X, Y, lon0, lat0, res } = grid, F = 3, X3 = Math.floor(X / F), Y3 = Math.floor(Y / F);
      const val = (x, y) => { if (x < 0 || y < 0 || x >= X || y >= Y) return 0; const v = gv(x, y); return v >= 0 && v < 100 ? v : 0; };
      const cur = new Uint8Array(X3 * Y3);
      for (let y = 0; y < Y3; y++) for (let x = 0; x < X3; x++) { let m = 0; for (let a = 0; a < F; a++) for (let b = 0; b < F; b++) { const v = val(x * F + b, y * F + a); if (v > m) m = v; } cur[y * X3 + x] = Math.min(255, Math.round(m)); }
      let prev = null;
      if (site) { try { const r = await fetch(site + "data/rgrid-prev.json?t=" + Date.now(), { signal: AbortSignal.timeout(20000) }); if (r.ok) prev = await r.json(); } catch (e) {} }
      // 同一張雷達重跑時，改用前一次保存的更早那張當比對基準
      if (prev && prev.time === grid.time) prev = prev.older || null;
      await writeFile(OUT + "/rgrid-prev.json", JSON.stringify({ time: grid.time, X3, Y3, d: Buffer.from(cur).toString("base64"), older: prev ? { time: prev.time, X3: prev.X3, Y3: prev.Y3, d: prev.d } : null }));
      const dt = prev && prev.time && grid.time ? (Date.parse(grid.time) - Date.parse(prev.time)) / 60e3 : 0;
      if (prev && prev.X3 === X3 && prev.Y3 === Y3 && dt >= 5 && dt <= 40) {
        const pv = new Uint8Array(Buffer.from(prev.d, "base64"));
        const cellKm = res * F * 111, R = Math.min(12, Math.ceil(90 * dt / 60 / cellKm));
        const at = (arr, x, y) => x < 0 || y < 0 || x >= X3 || y >= Y3 ? 0 : arr[y * X3 + x];
        const BS = 36, vecs = [];
        for (let by = 0; by + BS <= Y3; by += BS / 2) for (let bx = 0; bx + BS <= X3; bx += BS / 2) {
          let echo = 0; for (let y = by; y < by + BS; y++) for (let x = bx; x < bx + BS; x++) if (cur[y * X3 + x] >= 20) echo++;
          if (echo < 40) continue;
          let best = null, zero = null;
          for (let sy = -R; sy <= R; sy++) for (let sx = -R; sx <= R; sx++) {
            let cost = 0, n = 0;
            for (let y = by; y < by + BS; y += 2) for (let x = bx; x < bx + BS; x += 2) { const c = cur[y * X3 + x], p = at(pv, x - sx, y - sy); if (c || p) { cost += Math.abs(c - p); n++; } }
            if (!n) continue; cost /= n;
            if (sx === 0 && sy === 0) zero = cost;
            if (!best || cost < best.cost) best = { cost, sx, sy };
          }
          if (best && (zero === null || best.cost < zero * 0.97)) vecs.push({ cx: bx + BS / 2, cy: by + BS / 2, vx: best.sx / dt, vy: best.sy / dt, w: echo });
        }
        if (vecs.length) {
          const med = k => { const s = vecs.map(v => v[k]).sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
          const gvx = med("vx"), gvy = med("vy");
          // 每個粗格點的移動向量：附近區塊加權平均，太遠就用全區中位數
          const VX = new Float32Array(X3 * Y3), VY = new Float32Array(X3 * Y3);
          for (let y = 0; y < Y3; y += 4) for (let x = 0; x < X3; x += 4) {
            let ws = 0.15, sx = gvx * 0.15, sy = gvy * 0.15;
            for (const v of vecs) { const d2 = ((v.cx - x) ** 2 + (v.cy - y) ** 2) / (BS * BS); if (d2 > 4) continue; const w = v.w / 100 / (0.25 + d2); ws += w; sx += w * v.vx; sy += w * v.vy; }
            for (let a = 0; a < 4 && y + a < Y3; a++) for (let b = 0; b < 4 && x + b < X3; b++) { VX[(y + a) * X3 + x + b] = sx / ws; VY[(y + a) * X3 + x + b] = sy / ws; }
          }
          const kmh = Math.hypot(gvx * 0.915, gvy) * cellKm * 60;
          nowcast.motion = { vecs: vecs.length, kmh: Math.round(kmh), dir: Math.round((Math.atan2(gvx, gvy) * 180 / Math.PI + 360) % 360), dt };
          // 推估圖層（+30、+60 分鐘）
          const vAt = (x, y) => { const cx = Math.min(X3 - 1, Math.max(0, Math.floor(x / F))), cy = Math.min(Y3 - 1, Math.max(0, Math.floor(y / F))); return [VX[cy * X3 + cx], VY[cy * X3 + cx]]; };
          for (const lead of [30, 60]) {
            const fname = "rgrid/n-" + lead + "-" + Math.floor(Date.parse(grid.time) / 60e3) + ".png";
            const png = makeOverlay((px, gy) => { const [vx, vy] = vAt(px, gy); return val(Math.round(px - vx * F * lead), Math.round(gy - vy * F * lead)); });
            if (png) { await writeFile(OUT + "/" + fname, png); nowcast.frames.push({ file: fname, time: new Date(Date.parse(grid.time) + lead * 60e3).toISOString(), lead }); }
          }
          // 各鄉鎮：1 小時內雨帶會不會到
          const cAt = (x, y) => at(cur, x, y), near = (x, y, r) => { let m = 0; for (let a = -r; a <= r; a++) for (let b = -r; b <= r; b++) { const v = cAt(x + b, y + a); if (v > m) m = v; } return m; };
          const DIR = ["北", "東北", "東", "東南", "南", "西南", "西", "西北"], dirOf = deg => DIR[Math.round(((deg % 360) + 360) % 360 / 45) % 8];
          for (const key in townData) {
            const T = townData[key]; if (!T || T.lat == null) continue;
            const tx = (T.lon - lon0) / res / F, ty = (T.lat - lat0) / res / F;
            if (tx < 0 || ty < 0 || tx >= X3 || ty >= Y3) continue;
            if (near(Math.round(tx), Math.round(ty), 1) >= 20) continue;
            const ci0 = Math.min(X3 - 1, Math.floor(tx)), cj0 = Math.min(Y3 - 1, Math.floor(ty)), vx = VX[cj0 * X3 + ci0], vy = VY[cj0 * X3 + ci0];
            for (let L = 10; L <= 60; L += 10) {
              const sx = Math.round(tx - vx * L), sy = Math.round(ty - vy * L);
              if (near(sx, sy, 1) >= 25) {
                const dxk = (sx - tx) * cellKm * Math.cos(T.lat * Math.PI / 180), dyk = (sy - ty) * cellKm;
                nowcast.towns[key] = { eta: L, km: Math.round(Math.hypot(dxk, dyk)), from: dirOf(Math.atan2(dxk, dyk) * 180 / Math.PI), to: dirOf(Math.atan2(vx, vy) * 180 / Math.PI), kmh: Math.round(Math.hypot(vx * Math.cos(T.lat * Math.PI / 180), vy) * cellKm * 60) };
                break;
              }
            }
          }
          nowcast.motion.towns = Object.keys(nowcast.towns).length;
        }
      } else nowcast.motion = { skipped: prev ? "dt " + Math.round(dt) : "no prev" };
    }
  } catch (e) { fail("雨帶推估", e); }
  status.seen.nowcast = nowcast.motion;
  await writeFile(OUT + "/nowcast.json", JSON.stringify(nowcast));

  // 診斷：國土測繪中心圖資
  if (process.env.SAT_DIAG) {
    const out = {};
    for (const layer of ["EMAP", "EMAP2", "EMAP5", "EMAP6", "EMAP8", "PHOTO2", "PHOTO_MIX", "TOWN", "CITY", "Village", "LUIMAP"]) {
      try { const r = await fetch(`https://wmts.nlsc.gov.tw/wmts/${layer}/default/GoogleMapsCompatible/10/442/856`, { signal: AbortSignal.timeout(15000) }); out[layer] = r.status + " " + (r.headers.get("content-type") || "") + " " + (r.headers.get("content-length") || ""); }
      catch (e) { out[layer] = "ERR " + String(e.message || e).slice(0, 50); }
    }
    status.seen.nlsc = out;
  }

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

      const echo = (lat, lon, km) => {
        if (!grid) return null;
        const { v, X, Y, lon0, lat0, res } = grid, dLat = km / 111, dLon = km / (111 * Math.cos(lat * Math.PI / 180));
        let m = -99;
        for (let y = Math.max(0, Math.floor((lat - dLat - lat0) / res)); y <= Math.min(Y - 1, Math.ceil((lat + dLat - lat0) / res)); y++)
          for (let x = Math.max(0, Math.floor((lon - dLon - lon0) / res)); x <= Math.min(X - 1, Math.ceil((lon + dLon - lon0) / res)); x++) {
            const val = v[(grid.flip ? Y - 1 - y : y) * X + x]; if (val > m && val < 100) m = val;
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
            if (e10 !== null && e10 >= 30) out.push({ k: "rd|" + key, cool: 3, text: `${name}｜10 公里內有降雨，建議收衣` });
            else { const n = nowcast.towns[key]; if (n && n.eta <= 45) out.push({ k: "nc|" + key, cool: 3, text: `${name}｜雨帶約 ${n.eta} 分鐘後抵達（${n.from}方 ${n.km} 公里，雷達推估）` }); }
            const rows = (T.f || []).map(r => ({ ms: Date.parse(r[0]), p: r[3] })).filter(r => r.p != null);
            const cur = rows.filter(r => r.ms <= now).pop(), up = rows.find(r => r.ms > now && r.ms <= now + 3 * 3600e3 && r.p >= 70);
            if (up && (!cur || cur.p < 50)) out.push({ k: "fc|" + key + "|" + up.ms, cool: 24, text: `${name}｜${new Date(up.ms + 8 * 3600e3).getUTCHours()} 時起降雨機率 ${up.p}%` });
          }
          for (const z of (warn[p.c] || []).filter(z => /雨|颱風/.test(z.name))) out.push({ k: "wn|" + p.c + "|" + z.name + "|" + z.end, cool: 24, text: `${p.c}｜${z.name}` });
        }
        return (cache[key] = out);
      };
      // 每天早上 6 點（今天）、晚上 8 點（明天＋這週），加上預報有明顯改變時，依你選的地點推一則簡短通知
      const twNow = new Date(now + 8 * 3600e3), todayStr = twNow.toISOString().slice(0, 10);
      const digestMode = twH === 6 ? "am" : twH === 20 ? "pm" : null, preview = !!process.env.DIGEST_PREVIEW;
      const WK = ["日", "一", "二", "三", "四", "五", "六"];
      const dayName = (date, ahead) => { const wd = new Date(date + "T00:00:00Z").getUTCDay(); return ahead === 0 ? "今日" : ahead === 1 ? "明日" : ahead === 2 ? "後天" : ((ahead >= 7 || (wd !== 0 && wd <= twNow.getUTCDay()) || (twNow.getUTCDay() === 0 && wd !== 0)) ? "下週" : "週") + WK[wd]; };
      const ahead = d => Math.round((Date.parse(d) - Date.parse(todayStr)) / 864e5);
      // 原因：從氣象署「全臺天氣小幫手」裡挑出講天氣系統的句子（東北季風、冷空氣、鋒面…）
      const whyOf = { 今天: null, 明天: null };
      if (digestMode || preview) {
        try {
          const j = await fileapi("F-C0032-031"), u = findUrl(j, /^https?:\/\/\S+$/i);
          const r = await fetch(u, { signal: AbortSignal.timeout(20000) });
          let txt = new TextDecoder("big5").decode(Buffer.from(await r.arrayBuffer()));
          txt = txt.replace(/[０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0)).replace(/\s+/g, "");
          const KEY = /東北季風|冷空氣|冷氣團|寒流|鋒面|華南雲雨區|颱風|熱帶性低氣壓|低壓|西南氣流|西南風|南風|東風|太平洋高壓|高壓|輻射冷卻|熱對流|水氣/;
          const para = w => { const m = txt.match(new RegExp(w + "（\\d+日）(.*?)(?=今天（|今晚|明天（|後天（|離島天氣|根據|$)")); return m ? m[1] : ""; };
          const pick = p => { const cl = p.split(/[，；。]/).filter(c => KEY.test(c) && !/溫度方面|高溫|低溫/.test(c)).map(c => c.replace(/^環境/, "")).slice(0, 2); return cl.length ? cl.join("、") : null; };
          const t0 = pick(para("今天")), t1 = pick(para("明天"));
          whyOf.今天 = t0 || t1; whyOf.明天 = t1 || t0;
          status.seen.digestWhy = whyOf;
        } catch (e) { status.seen.digestWhy = "讀取失敗 " + String(e.message || e).slice(0, 80); }
      }
      const placesOf = s => (s.places || []).slice(0, 4).map(p => ({ name: p.t.length > 2 ? p.t.replace(/[區鄉鎮市]$/, "") : p.t, T: townData[p.c + "|" + p.t] })).filter(x => x.T && x.T.w && x.T.w.length);
      const coldMonth = () => { const m = twNow.getUTCMonth() + 1; return m >= 10 || m <= 4; };
      // 整理成「事實」：明天會不會下雨、最近的雨天、轉涼的日子、很熱的日子
      const factsOf = s => {
        const pl = placesOf(s); if (!pl.length) return null;
        const dayRows = date => pl.map(x => x.T.w.find(r => r[0] === date)).filter(Boolean);
        const dates = [...new Set(pl.flatMap(x => x.T.w.map(r => r[0])))].filter(d => d >= todayStr).sort().slice(0, 8);
        const hiOf = d => { const rs = dayRows(d).filter(r => r[1] != null); return rs.length ? [Math.min(...rs.map(r => r[1])), Math.max(...rs.map(r => r[1]))] : null; };
        const catOf = d => { const R = dayRows(d); if (!R.length) return null; const pop = Math.max(...R.map(r => r[4] ?? 0)), wet = R.reduce((a, r) => a | (r[6] || 0), 0); return pop >= 60 || wet & 1 ? "wet" : wet & 2 ? "night" : pop >= 30 ? "maybe" : "dry"; };
        const t1 = dates.find(d => d > todayStr), rest = dates.filter(d => d > t1);
        const rainDay = rest.find(d => dayRows(d).some(r => (r[4] ?? 0) >= 50 || r[6])) || null;
        let cold = null, prevMax = t1 && hiOf(t1) ? hiOf(t1)[1] : null;
        for (const d of rest) { const h = hiOf(d); if (!h) continue; if (prevMax != null && prevMax - h[1] >= 5) { cold = d; break; } prevMax = Math.max(prevMax ?? h[1], h[1]); }
        const hot = rest.find(d => { const h = hiOf(d); return h && h[1] >= 33; }) || null;
        return { pl, dayRows, hiOf, catOf, t1, rainDay, rainNight: rainDay ? dayRows(rainDay).reduce((a, r) => a | (r[6] || 0), 0) === 2 : false, cold, hot, t1cat: t1 ? catOf(t1) : null };
      };
      const VERD = { wet: "有雨，宜室內晾衣", night: "晚間降雨，宜傍晚前收衣", maybe: "可能短暫降雨，宜提早收衣", dry: "全日宜曬衣" };
      const rng = h => h[0] === h[1] ? h[1] : h[0] + "–" + h[1];
      const noteTexts = (F, max) => {
        const notes = [];
        if (F.rainDay) notes.push({ d: F.rainDay, t: `${dayName(F.rainDay, ahead(F.rainDay))}${F.rainNight ? "晚間" : ""}降雨` });
        if (F.cold) notes.push({ d: F.cold, t: `${dayName(F.cold, ahead(F.cold))}${coldMonth() ? "冷空氣南下" : "降溫"}，高溫 ${rng(F.hiOf(F.cold))}°` });
        if (F.hot && notes.length < max) notes.push({ d: F.hot, t: `${dayName(F.hot, ahead(F.hot))}高溫 ${F.hiOf(F.hot)[1]}°` });
        return notes.sort((a, b) => a.d < b.d ? -1 : 1).slice(0, max).map(n => n.t);
      };
      const digestFor = (s, mode) => {
        const F = factsOf(s); if (!F) return null;
        if (mode === "am") {
          // 今天：溫度＋什麼時候可能下雨（逐時預報）
          const temps = F.pl.map(x => { const r = x.T.w.find(r => r[0] === todayStr); return r && r[1] != null ? `${x.name} ${Math.round(r[2])}–${Math.round(r[1])}°` : null; }).filter(Boolean);
          if (!temps.length) return null;
          let first = null;
          for (const x of F.pl) for (const r of x.T.f || []) { const t = Date.parse(r[0]), h = new Date(t + 8 * 3600e3).getUTCHours(); if (r[0].slice(0, 10) !== todayStr || h < 6 || h > 21) continue; if ((r[3] ?? 0) >= 50 || isRainCode(r[4])) { if (!first || t < first.t) first = { t, h }; break; } }
          const verdict = !first ? "全日宜曬衣" : first.h <= 9 ? "上午起可能降雨，宜室內晾衣" : `${first.h} 時起可能降雨，宜${first.h >= 18 ? "傍晚" : first.h >= 13 ? "中午" : "上午"}前收衣`;
          const n = noteTexts(F, 1);
          return { title: "今日天氣", body: [whyOf.今天, temps.join("　"), verdict + (n.length ? "｜" + n[0] : "")].filter(Boolean).join("\n") };
        }
        if (!F.t1) return null;
        const temps = F.pl.map(x => { const r = x.T.w.find(r => r[0] === F.t1); return r && r[1] != null ? `${x.name} ${Math.round(r[2])}–${Math.round(r[1])}°` : null; }).filter(Boolean);
        const n = noteTexts(F, 2);
        return { title: "明日天氣", body: [whyOf.明天, temps.join("　"), (VERD[F.t1cat] || "全日宜曬衣") + (n.length ? "｜" + n.join("・") : "")].filter(Boolean).join("\n") };
      };
      // 預報改變：跟上次告訴你的內容比，明天能不能曬變了、雨天提前、冷空氣或高溫新出現
      state.fx = state.fx && typeof state.fx === "object" ? state.fx : {};
      const snap = F => ({ t1: F.t1, c: F.t1cat, r: F.rainDay, k: F.cold, h: F.hot, at: now });
      const changeFor = (F, old) => {
        const out = [];
        if (old.t1 === F.t1 && old.c && F.t1cat && old.c !== F.t1cat) {
          const wetNow = F.t1cat === "wet" || F.t1cat === "night", wetOld = old.c === "wet" || old.c === "night";
          if (wetNow !== wetOld) out.push(wetNow ? `明日轉為${F.t1cat === "wet" ? "降雨，宜室內晾衣" : "晚間降雨，宜傍晚前收衣"}` : "明日轉為無雨，宜曬衣");
        }
        if (F.rainDay && F.rainDay !== old.r && (!old.r || F.rainDay < old.r) && ahead(F.rainDay) <= 4) out.push(`${dayName(F.rainDay, ahead(F.rainDay))}${F.rainNight ? "晚間" : ""}可能降雨`);
        if (F.cold && !old.k) out.push(`${dayName(F.cold, ahead(F.cold))}${coldMonth() ? "冷空氣南下" : "降溫"}，高溫 ${rng(F.hiOf(F.cold))}°`);
        if (F.hot && !old.h) out.push(`${dayName(F.hot, ahead(F.hot))}高溫 ${F.hiOf(F.hot)[1]}°`);
        return out;
      };
      let changes = 0;
      const pushOne = async (s, payload) => libs.push.sendNotification(s.sub, JSON.stringify({ ...payload, url: site || "./" }),
        { TTL: 3 * 3600, urgency: "normal", vapidDetails: { subject: site || "https://github.com", publicKey: s.pub, privateKey: s.priv } });
      const sendDigest = async (s, sh) => {
        const F = factsOf(s); if (!F) return;
        if (digestMode) {
          const k = hash(sh + "|dg|" + digestMode + "|" + todayStr);
          if (!state.sent[k]) {
            const d = digestFor(s, digestMode); if (!d) return;
            try { await pushOne(s, { title: d.title, body: d.body, tag: "daily" }); state.sent[k] = now; state.fx[sh] = snap(F); digests++; if (!status.seen.digestSample) status.seen.digestSample = d.body; }
            catch (e) { if (e.statusCode !== 404 && e.statusCode !== 410) fail("每日預報通知", (e.statusCode || "") + " " + String(e.body || e.message || "").slice(0, 120)); }
            return;
          }
        }
        const old = state.fx[sh];
        if (!old) { state.fx[sh] = snap(F); return; }               // 第一次只記下來，不推
        if (quiet || now - (old.at || 0) < 4 * 3600e3) return;      // 夜裡不吵你；預報改變最多 4 小時推一次
        const ch = changeFor(F, old);
        if (!ch.length) { state.fx[sh] = { ...snap(F), at: old.at }; return; }
        try { await pushOne(s, { title: "預報更新", body: ch.join("\n"), tag: "change" }); state.fx[sh] = snap(F); changes++; }
        catch (e) { if (e.statusCode !== 404 && e.statusCode !== 410) fail("預報改變通知", (e.statusCode || "") + " " + String(e.body || e.message || "").slice(0, 120)); }
      };
      if (preview) { for (const s of subs) { const a = digestFor(s, "am"), b = digestFor(s, "pm"); if (a || b) { status.seen.digestPreview = { am: a && a.body, pm: b && b.body }; break; } } }
      let digests = 0;
      const dead = [];
      let sent = 0, failed = 0;
      const one = async s => {
        const sh = hash(s.id + "|" + (s.sub && s.sub.endpoint)), lines = [], keys = [];
        await sendDigest(s, sh);
        const seenText = new Set();
        for (const p of (s.places || []).slice(0, 8)) for (const a of alertsFor(p)) {
          const k = hash(sh + "|" + a.k);
          if (state.sent[k] && now - state.sent[k] < a.cool * 3600e3) continue;
          if (!seenText.has(a.text)) { lines.push(a.text); seenText.add(a.text); }
          keys.push(k);
        }
        const hello = state.hello[sh] !== 1;
        if (!lines.length) return;
        try {
          await libs.push.sendNotification(s.sub, JSON.stringify({ title: "降雨提醒", body: lines.join("\n"), tag: "rain", url: site || "./" }),
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
      status.seen.push = { subs: subs.length, sent, failed, removed: dead.length, quiet, digests, changes };
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
