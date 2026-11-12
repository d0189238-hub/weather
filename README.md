# 今天曬衣服嗎

給自己用的天氣網頁：現在溫度與體感、逐三小時預報、穿著與生活建議、一週高低溫、空氣品質旗號，可儲存多個鄉鎮市區。

## 資料來源

- 中央氣象署開放資料平臺：鄉鎮天氣預報（F-D0047 系列）、現在天氣觀測（O-A0003-001、O-A0001-001）
- 環境部環境資料開放平臺：空氣品質指標 AQI（aqx_p_432）

## 運作方式

`.github/workflows/update.yml` 每半小時執行 `scripts/fetch.mjs`，把資料整理成 `data/*.json`，連同網頁一起發布到 GitHub Pages。網頁只讀這些檔案，金鑰不會出現在網頁裡。

## 設定

1. Settings → Secrets and variables → Actions → New repository secret，新增兩個：
   - `CWA_KEY`：中央氣象署授權碼
   - `MOENV_KEY`：環境部 API Key
2. Settings → Pages → Source 選 **GitHub Actions**。
3. Actions 分頁 → 「更新天氣資料並發布網站」→ Run workflow。

發布後可在 `data/status.json` 看最近一次抓取的結果與錯誤訊息。
