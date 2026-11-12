// 定時向中央氣象署、環境部抓資料，整理成網頁要讀的 data/*.json。
// 金鑰只從環境變數讀（GitHub Secrets：CWA_KEY、MOENV_KEY），不會寫進任何輸出檔。
import { mkdir, writeFile, readFile, unlink } from "node:fs/promises";
import { execFileSync } from "node:child_process";

const CWA = (process.env.CWA_KEY || "").trim();
const MOENV = (process.env.MOENV_KEY || "").trim();
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
const scrub = s => String(s).split(CWA || "\u0000").join("***").split(MOENV || "\u0000").join("***");
const fail = (where, e) => { status.errors.push(where + ": " + scrub(e && e.message || e).slice(0, 300)); };

// 不分大小寫取欄位，氣象署改過幾次欄位大小寫
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

async function getJSON(url, tries = 3) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(60000), headers: { accept: "application/json" } });
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
  let pop = null, wc = null, wx = null;
  const rows = [];
  for (const [t, v] of timeline(loc, "3day")) {
    const p = ci(v, "ProbabilityOfPrecipitation"); if (p !== undefined && num(p) !== null) pop = num(p);
    const c = ci(v, "WeatherCode"); if (c !== undefined) { wc = String(c); wx = ci(v, "Weather") || wx; }
    const temp = num(ci(v, "Temperature"));
    if (temp === null) continue;
    const ms = Date.parse(t);
    if (ms < now - 4 * 3600e3 || ms > now + 76 * 3600e3) continue;
    rows.push([t, temp, num(ci(v, "ApparentTemperature")), pop, wc, wx]);
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
  const towns = {};
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
        out[town] = {
          lat, lon, f, w,
          o: o && { station: o.station, time: o.time, temp: o.temp, rh: o.rh, rain: o.rain, ws: o.ws, wd: o.wd, km: o.km },
          a: q && { site: q.site, time: q.time, aqi: q.aqi, status: q.status, pm25: q.pm25, pm10: q.pm10, o3: q.o3, no2: q.no2, so2: q.so2, co: q.co, km: q.km }
        };
      }
      const list = Object.keys(out);
      status.counties[name] = list.length;
      if (!list.length) throw new Error("沒有解析出任何鄉鎮");
      towns[name] = list;
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
