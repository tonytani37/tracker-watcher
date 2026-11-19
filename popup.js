document.addEventListener("DOMContentLoaded", async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;

  chrome.runtime.sendMessage({ type: "GET_DETECTIONS", tabId: tab.id }, (res) => {
    const knownContainer = document.getElementById("known-list");

    if (!res || (res.known.length === 0 && res.unknownExternal.length === 0)) {
      knownContainer.innerHTML = `<div class="empty">外部ツールへのデータ送信は検知されていません。</div>`;
      return;
    }

    if (res.known.length === 0) {
      knownContainer.innerHTML = `<div class="empty">既知の主要CX・解析ツールは検知されませんでした。</div>`;
    } else {
      res.known.forEach((item) => {
        const div = document.createElement("div");
        div.className = `card ${item.risk}`;

        // ペイロード解析結果がある場合の表示HTMLを組み立て
        let payloadHtml = "";
        if (item.payload) {
          const findingsText = item.payload.findings.length > 0
            ? `<div style="color:#d93025; font-weight:bold; font-size:11px; margin-top:4px;">⚠ 検出: ${item.payload.findings.join(" / ")}</div>`
            : "";
          const keysText = item.payload.keys.length > 0
            ? `<div style="font-size:10px; color:#5f6368; margin-top:2px;">送信キー: ${item.payload.keys.join(", ")}</div>`
            : "";
          payloadHtml = `
            ${findingsText}
            ${keysText}
            <div class="payload-preview" style="font-family:monospace; font-size:10px; background:#f1f3f4; padding:4px; border-radius:4px; margin-top:4px; word-break:break-all;"></div>
          `;
        }

        div.innerHTML = `
          <div class="title">${item.name} (${item.count}回)</div>
          <div class="meta">${item.host} / ${item.method}</div>
          <div class="desc">${item.desc}</div>
          ${payloadHtml}
        `;

        // XSS防止のため、生のペイロード文字列は textContent で安全に挿入
        if (item.payload) {
          const codeBox = div.querySelector(".payload-preview");
          if (codeBox) codeBox.textContent = item.payload.preview;
        }

        knownContainer.appendChild(div);
      });
    }

    if (res.unknownExternal.length > 0) {
      document.getElementById("unknown-section").style.display = "block";
      const ul = document.getElementById("unknown-list");
      res.unknownExternal.forEach((entry) => {
        const li = document.createElement("li");
        li.textContent = entry;
        ul.appendChild(li);
      });
    }
  });
});