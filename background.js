// 監視対象とする代表的な外部CX・解析・マーケティングツールのドメイン辞書
const KNOWN_TRACKERS = [
  { pattern: "karte.io", name: "KARTE (プレイド)", risk: "high", desc: "リアルタイム行動解析・接客SDK" },
  { pattern: "googletagmanager.com", name: "Google Tag Manager", risk: "medium", desc: "外部タグ一括管理コンテナ" },
  { pattern: "google-analytics.com", name: "Google Analytics", risk: "low", desc: "アクセス解析" },
  { pattern: "doubleclick.net", name: "Google Ads / DoubleClick", risk: "medium", desc: "広告トラッキング" },
  { pattern: "facebook.net", name: "Meta Pixel", risk: "medium", desc: "SNS行動追跡・広告連携" },
  { pattern: "line-scdn.net", name: "LINE Tag", risk: "medium", desc: "LINE広告・行動計測" },
  { pattern: "hubspot.com", name: "HubSpot", risk: "high", desc: "MA・顧客データ連携" },
  { pattern: "salesforce.com", name: "Salesforce / Pardot", risk: "high", desc: "CRM・顧客情報連携" },
  { pattern: "clarity.ms", name: "Microsoft Clarity", risk: "medium", desc: "ヒートマップ・操作録画" },
  { pattern: "hotjar.com", name: "Hotjar", risk: "medium", desc: "行動録画・ヒートマップ" }
];

// タブIDごとの検知データをメモリに保持
const tabDetections = {};

// 送信ペイロード（requestBody）を解析し、機微なキーや値パターンを抽出する
function inspectRequestBody(requestBody) {
  if (!requestBody) return null;

  let rawText = "";

  // 1. formData形式（application/x-www-form-urlencoded 等）の場合
  if (requestBody.formData) {
    rawText = JSON.stringify(requestBody.formData);
  }
  // 2. raw形式（JSON文字列やBeaconのバイナリペイロード等）の場合
  else if (requestBody.raw && requestBody.raw.length > 0) {
    const decoder = new TextDecoder("utf-8");
    rawText = requestBody.raw
      .map((part) => (part.bytes ? decoder.decode(part.bytes) : ""))
      .join("");
  }

  if (!rawText) return null;

  // 検知する機微データ・識別子のパターン
  const findings = [];
  if (/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/.test(rawText)) {
    findings.push("メールアドレス(生データ)");
  }
  if (/\b[a-fA-F0-9]{64}\b/.test(rawText)) {
    findings.push("SHA-256ハッシュ値(識別子疑い)");
  }
  if (/["']?(email|mail|user_id|userid|member_id|tel|phone|address|name)["']?\s*[:=]/i.test(rawText)) {
    findings.push("会員・個人属性キー");
  }

  // JSONとしてパース可能ならトップレベルのキー一覧も取得（最大5件）
  let keys = [];
  try {
    const parsed = JSON.parse(rawText);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      keys = Object.keys(parsed).slice(0, 5);
    }
  } catch (e) {
    // JSON以外の形式（クエリ文字列等）の場合は無視
  }

  return {
    findings,
    keys,
    // 確認用に先頭120文字だけ抜粋（メモリ圧迫防止）
    preview: rawText.slice(0, 120) + (rawText.length > 120 ? "..." : "")
  };
}

// タブが更新（別ページへ遷移）されたら履歴をリセット
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === "loading") {
    tabDetections[tabId] = {
      known: {},
      unknownExternal: new Set(),
      hasSensitiveForm: false,
      formFields: []
    };
    updateBadge(tabId);
  }
});

// タブが閉じられたらメモリ解放
chrome.tabs.onRemoved.addListener((tabId) => {
  delete tabDetections[tabId];
});

// すべてのHTTP/HTTPSリクエストを監視
chrome.webRequest.onBeforeRequest.addListener(
  async (details) => {
    // タブに紐づかないバックグラウンド通信は除外
    if (details.tabId < 0) return;

    try {
      const targetUrl = new URL(details.url);
      const targetHost = targetUrl.hostname;

      // 現在のタブのURL（ファーストパーティ）を取得
      const tab = await chrome.tabs.get(details.tabId);
      if (!tab.url || !tab.url.startsWith("http")) return;

      const pageHost = new URL(tab.url).hostname;

      // 同一ドメイン（またはサブドメイン）ならスキップ
      if (targetHost === pageHost || targetHost.endsWith("." + pageHost)) {
        return;
      }

      if (!tabDetections[details.tabId]) {
        tabDetections[details.tabId] = {
          known: {},
          unknownExternal: new Set(),
          hasSensitiveForm: false,
          formFields: []
        };
      }

      const record = tabDetections[details.tabId];

      // POST / PUT 等のリクエストボディがあれば中身を解析
      const payloadInfo = inspectRequestBody(details.requestBody);

      // 既知のトラッカー辞書と照合
      const matched = KNOWN_TRACKERS.find((t) => targetHost.includes(t.pattern));
      if (matched) {
        const prev = record.known[matched.name];
        record.known[matched.name] = {
          ...matched,
          host: targetHost,
          method: details.method,
          type: details.type,
          count: (prev?.count || 0) + 1,
          // ペイロード解析結果があれば保持（直近のものを上書き維持）
          payload: payloadInfo || prev?.payload || null
        };

        // すでにフォーム検知済みで、かつ今回 high リスクツールが発火したらバナー表示を指示
        if (record.hasSensitiveForm && matched.risk === "high") {
          const highRiskTools = Object.values(record.known).filter((t) => t.risk === "high");
          chrome.tabs.sendMessage(details.tabId, {
            type: "SHOW_WARNING_BANNER",
            tools: highRiskTools
          }).catch(() => {});
        }
      } else {
        // 辞書にない外部ドメインへのPOSTやBeacon送信なども記録
        if (details.method === "POST" || details.type === "ping" || details.type === "xmlhttprequest") {
          const alertTag = payloadInfo?.findings?.length
            ? ` [検知: ${payloadInfo.findings.join(", ")}]` : ""; record.unknownExternal.add(`${targetHost} (${details.method})${alertTag}`);
        }
      }

      updateBadge(details.tabId);
    } catch (e) {
      // タブ取得エラー等は無視
    }
  },
  { urls: ["<all_urls>"] },
  ["requestBody"]
);

// アイコン上のバッジ表示を更新
function updateBadge(tabId) {
  const record = tabDetections[tabId];
  if (!record) return;

  const knownList = Object.values(record.known);
  const count = knownList.length;

  if (count === 0) {
    chrome.action.setBadgeText({ tabId, text: "" });
    return;
  }

  // highリスク（KARTEやCRM系）が含まれていれば赤、それ以外はオレンジ
  const hasHighRisk = knownList.some((item) => item.risk === "high");
  chrome.action.setBadgeBackgroundColor({
    tabId,
    color: hasHighRisk ? "#D93025" : "#F29900"
  });
  chrome.action.setBadgeText({ tabId, text: String(count) });
}

// popup.js / content.js からのメッセージに応答
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "GET_DETECTIONS") {
    const record = tabDetections[msg.tabId] || {
      known: {},
      unknownExternal: new Set(),
      formFields: []
    };
    sendResponse({
      known: Object.values(record.known),
      unknownExternal: Array.from(record.unknownExternal),
      formFields: record.formFields || []
    });
  }

  // content.js からフォーム検知の報告を受けた場合
  if (msg.type === "FORM_DETECTED" && sender.tab) {
    const tabId = sender.tab.id;
    if (!tabDetections[tabId]) {
      tabDetections[tabId] = {
        known: {},
        unknownExternal: new Set(),
        hasSensitiveForm: false,
        formFields: []
      };
    }
    tabDetections[tabId].hasSensitiveForm = true;
    tabDetections[tabId].formFields = msg.fields || [];

    // すでに high リスクの外部ツールが検知済みならレスポンスで返す
    const highRiskTools = Object.values(tabDetections[tabId].known).filter(
      (t) => t.risk === "high"
    );
    sendResponse({ highRiskTools });
  }

  return true;
});