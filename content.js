(() => {
  let bannerShown = false;
  let detectedFormFields = [];

  // 個人情報・認証情報に該当するフォーム項目を判定するルール
  const SENSITIVE_PATTERNS = [
    { label: "パスワード", regex: /password|passwd|pass/i, types: ["password"] },
    { label: "メールアドレス", regex: /e-?mail|mail/i, types: ["email"] },
    { label: "電話番号", regex: /tel|phone|mobile/i, types: ["tel"] },
    { label: "氏名", regex: /name|sei|mei|kanji|kana/i, types: [] },
    { label: "住所・郵便番号", regex: /address|zip|postal|pref|city|addr/i, types: [] },
    { label: "クレジットカード", regex: /card|cc-|cvv|cvc|exp/i, types: [] }
  ];

  // ページ内の入力フォームをスキャン
  function scanSensitiveForms() {
    const inputs = document.querySelectorAll("input, textarea, select");
    const foundLabels = new Set();

    inputs.forEach((el) => {
      // 非表示要素は除外
      if (el.type === "hidden" || el.offsetParent === null) return;

      const type = (el.getAttribute("type") || "").toLowerCase();
      const attrString = [
        el.name,
        el.id,
        el.getAttribute("autocomplete"),
        el.getAttribute("placeholder"),
        el.getAttribute("aria-label")
      ]
        .filter(Boolean)
        .join(" ");

      for (const rule of SENSITIVE_PATTERNS) {
        if (rule.types.includes(type) || rule.regex.test(attrString)) {
          foundLabels.add(rule.label);
        }
      }
    });

    detectedFormFields = Array.from(foundLabels);
    return detectedFormFields.length > 0;
  }

  // 警告バナーをページ最上部に表示（Shadow DOMでサイト側のCSS干渉を防止）
  function showWarningBanner(tools) {
    if (bannerShown || detectedFormFields.length === 0 || tools.length === 0) return;
    bannerShown = true;

    const host = document.createElement("div");
    host.id = "external-data-watcher-banner-host";
    host.style.cssText = "position: fixed; top: 0; left: 0; width: 100%; z-index: 2147483647;";

    const shadow = host.attachShadow({ mode: "open" });

    const toolNames = tools.map((t) => t.name).join("、");
    const fieldNames = detectedFormFields.join("・");

    shadow.innerHTML = `
      <style>
        .banner {
          background: #b31412;
          color: #ffffff;
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
          font-size: 13px;
          line-height: 1.5;
          padding: 10px 16px;
          box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 12px;
        }
        .content {
          display: flex;
          align-items: center;
          gap: 10px;
        }
        .badge {
          background: #ffffff;
          color: #b31412;
          font-weight: bold;
          font-size: 11px;
          padding: 2px 6px;
          border-radius: 4px;
          white-space: nowrap;
        }
        .close-btn {
          background: rgba(255, 255, 255, 0.2);
          border: 1px solid rgba(255, 255, 255, 0.5);
          color: #ffffff;
          border-radius: 4px;
          padding: 4px 10px;
          cursor: pointer;
          font-size: 12px;
          white-space: nowrap;
        }
        .close-btn:hover {
          background: rgba(255, 255, 255, 0.35);
        }
      </style>
      <div class="banner">
        <div class="content">
          <span class="badge">外部データ送信警告</span>
          <div>
            このページには入力フォーム（<strong>${fieldNames}</strong>）が存在し、裏側で外部ツール（<strong>${toolNames}</strong>）への通信が動作しています。
          </div>
        </div>
        <button class="close-btn" id="close-banner">閉じる</button>
      </div>
    `;

    shadow.getElementById("close-banner").addEventListener("click", () => {
      host.remove();
    });

    if (document.body) {
      document.body.prepend(host);
    }
  }

  // 初回スキャンして background.js へ通知
  function reportFormStatus() {
    const hasSensitiveForm = scanSensitiveForms();
    if (hasSensitiveForm) {
      chrome.runtime.sendMessage(
        {
          type: "FORM_DETECTED",
          fields: detectedFormFields
        },
        (res) => {
          // すでに外部CXツールが検知済みなら即座にバナー表示
          if (res && res.highRiskTools && res.highRiskTools.length > 0) {
            showWarningBanner(res.highRiskTools);
          }
        }
      );
    }
  }

  // background.js から「後から外部CXツールが発火した」通知を受け取った場合
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === "SHOW_WARNING_BANNER" && msg.tools) {
      if (detectedFormFields.length > 0 || scanSensitiveForms()) {
        showWarningBanner(msg.tools);
      }
    }
  });

  // 初期実行
  reportFormStatus();

  // SPA（React/Vue等）で後からフォームが描画されるケースに備えてDOM変化を監視
  if (document.body) {
    const observer = new MutationObserver(() => {
      if (!bannerShown && detectedFormFields.length === 0) {
        reportFormStatus();
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }
})();