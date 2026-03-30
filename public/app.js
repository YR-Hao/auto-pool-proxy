const summaryCards = document.querySelector("#summary-cards");
const usageContainer = document.querySelector("#usage");
const accountsWorkspace = document.querySelector("#accounts-workspace");
const proxyTargetSelect = document.querySelector("#proxy-target");
const applyProxyTargetButton = document.querySelector("#apply-proxy-target");
const proxyTargetStatus = document.querySelector("#proxy-target-status");
const connectivityTargetSelect = document.querySelector("#connectivity-target");
const runConnectivityTestButton = document.querySelector("#run-connectivity-test");
const connectivityResult = document.querySelector("#connectivity-result");
const form = document.querySelector("#upstream-form");
const refreshButton = document.querySelector("#refresh-all");
const healthDot = document.querySelector("#health-dot");
const adminTokenInput = document.querySelector("#admin-token");
const oauthModal = document.querySelector("#oauth-modal");
const openOAuthModalButton = document.querySelector("#open-oauth-modal");
const toggleUpstreamFormButton = document.querySelector("#toggle-upstream-form");
const closeUpstreamFormButton = document.querySelector("#close-upstream-form");
const upstreamFormPanel = document.querySelector("#upstream-form-panel");
const accountSearchInput = document.querySelector("#account-search");
const accountKindFilter = document.querySelector("#account-kind-filter");
const accountStateFilter = document.querySelector("#account-state-filter");
const generateAuthLinkButton = document.querySelector("#generate-auth-link");
const openAuthLinkButton = document.querySelector("#open-auth-link");
const authUrlOutput = document.querySelector("#auth-url-output");
const manualAccountNameInput = document.querySelector("#manual-account-name");
const authCodeInput = document.querySelector("#auth-code-input");
const completeAuthButton = document.querySelector("#complete-auth");
const useDetectedCallbackButton = document.querySelector("#use-detected-callback");
const rtAccountNameInput = document.querySelector("#rt-account-name");
const rtClientIdInput = document.querySelector("#rt-client-id");
const rtInput = document.querySelector("#rt-input");
const importRtButton = document.querySelector("#import-rt");
const oauthStatus = document.querySelector("#oauth-status");

let oauthSession = null;
let latestUpstreams = [];
let latestManagedAccounts = [];
let latestUsageWindows = { upstreams: {}, managedAccounts: {} };
let latestProxyTarget = {
  targetType: "auto",
  targetId: null,
  label: "自动选择",
  description: "按默认上游和故障切换策略自动代理。",
};

const TOKEN_KEY = "codex-switchboard-admin-token";

adminTokenInput.value = localStorage.getItem(TOKEN_KEY) || "";
adminTokenInput.addEventListener("change", () => {
  localStorage.setItem(TOKEN_KEY, adminTokenInput.value.trim());
});

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function currency(value) {
  return `$${Number(value || 0).toFixed(4)}`;
}

function number(value) {
  return Number(value || 0).toLocaleString("en-US");
}

function formatTime(value) {
  if (!value) {
    return "-";
  }
  return new Date(value).toLocaleString();
}

function formatUnix(value) {
  if (!value) {
    return "-";
  }
  return new Date(value * 1000).toLocaleString();
}

function statusMeta(item) {
  if (!item.enabled) {
    return { label: "停用", className: "status-off", stateKey: "disabled" };
  }
  if (item.lastError) {
    return { label: "异常", className: "status-error", stateKey: "error" };
  }
  return { label: "正常", className: "status-ok", stateKey: "healthy" };
}

function codexPercent(value) {
  return value === null || value === undefined ? "-" : `${Number(value).toFixed(0)}%`;
}

function formatRemainingResetTime(item) {
  if (!item) {
    return "剩余 -";
  }

  let remainingSeconds = null;
  if (item.resetAt) {
    const resetAtMs = Date.parse(item.resetAt);
    if (Number.isFinite(resetAtMs)) {
      remainingSeconds = Math.max(0, Math.ceil((resetAtMs - Date.now()) / 1000));
    }
  }

  if (remainingSeconds === null && item.resetAfterSeconds !== null && item.resetAfterSeconds !== undefined) {
    remainingSeconds = Math.max(0, Number(item.resetAfterSeconds) || 0);
  }

  if (remainingSeconds === null) {
    return "剩余 -";
  }

  if (remainingSeconds <= 0) {
    return "剩余 0m";
  }

  const totalMinutes = Math.max(1, Math.ceil(remainingSeconds / 60));
  const days = Math.floor(totalMinutes / (24 * 60));
  const hours = Math.floor((totalMinutes % (24 * 60)) / 60);
  const minutes = totalMinutes % 60;

  if (days > 0) {
    return `剩余 ${days}d ${hours}h ${minutes}m`;
  }

  if (hours > 0) {
    return `剩余 ${hours}h ${minutes}m`;
  }

  return `剩余 ${minutes}m`;
}

function upstreamUsageMarkup(windows) {
  const data =
    windows || {
      window24h: { requests: 0, totalTokens: 0, cost: 0 },
      window7d: { requests: 0, totalTokens: 0, cost: 0 },
    };

  return `
    <div class="usage-stack">
      <span class="window-chip label">24h</span>
      <span class="window-chip">${number(data.window24h.requests)} req</span>
      <span class="window-chip">${number(data.window24h.totalTokens)} tok</span>
      <span class="window-chip">${currency(data.window24h.cost)}</span>
    </div>
    <div class="usage-stack">
      <span class="window-chip label">7d</span>
      <span class="window-chip">${number(data.window7d.requests)} req</span>
      <span class="window-chip">${number(data.window7d.totalTokens)} tok</span>
      <span class="window-chip">${currency(data.window7d.cost)}</span>
    </div>
  `;
}

function managedUsageMarkup(snapshot) {
  if (!snapshot) {
    return `
      <div class="usage-stack">
        <span class="window-chip label">5h</span>
        <span class="window-chip">暂未探测</span>
      </div>
      <div class="usage-stack">
        <span class="window-chip label">7d</span>
        <span class="window-chip">暂未探测</span>
      </div>
    `;
  }

  const rows = [
    ["5h", snapshot.window5h],
    ["7d", snapshot.window7d],
  ];

  return `${rows
    .map(([label, item]) => {
      if (!item) {
        return `
          <div class="usage-stack">
            <span class="window-chip label">${label}</span>
            <span class="window-chip">-</span>
          </div>
        `;
      }

      return `
        <div class="usage-stack">
          <span class="window-chip label">${label}</span>
          <span class="window-chip">${codexPercent(item.usedPercent)} used</span>
          <span class="window-chip">${formatRemainingResetTime(item)}</span>
        </div>
      `;
    })
    .join("")}
    <div class="table-meta">更新时间 ${escapeHtml(formatTime(snapshot.updatedAt))}</div>
  `;
}

async function request(path, options = {}) {
  const token = localStorage.getItem(TOKEN_KEY) || "";
  const response = await fetch(path, {
    headers: {
      ...(options.body ? { "content-type": "application/json" } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(options.headers || {}),
    },
    ...options,
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(error.error || response.statusText);
  }

  return response.json();
}

async function fetchCallbackCache() {
  const payload = await request("/api/openai/oauth/callback-cache");
  return payload.callback || null;
}

function isCurrentProxyTarget(targetType, targetId) {
  return latestProxyTarget.targetType === targetType && Number(latestProxyTarget.targetId) === Number(targetId);
}

function renderSummary(summary) {
  const totals = summary?.totals || {};
  const cards = [
    ["账号总数", latestUpstreams.length + latestManagedAccounts.length, `${latestManagedAccounts.length} 官方 / ${latestUpstreams.length} 上游`],
    ["已启用", latestUpstreams.filter((item) => item.enabled).length + latestManagedAccounts.filter((item) => item.enabled).length, "可参与代理调度"],
    ["当前路由", latestProxyTarget.label || "自动选择", latestProxyTarget.description || ""],
    ["24h 请求", number(totals.requests), `${number(totals.totalTokens)} tokens`],
    ["输入 / 输出", `${number(totals.inputTokens)} / ${number(totals.outputTokens)}`, "24h token 统计"],
    ["24h 成本", currency(totals.cost), "按已配置价格计算"],
  ];

  summaryCards.innerHTML = cards
    .map(
      ([label, value, meta]) => `
        <article class="stat-card">
          <p>${escapeHtml(label)}</p>
          <strong>${escapeHtml(value)}</strong>
          <div class="stat-meta">${escapeHtml(meta)}</div>
        </article>
      `,
    )
    .join("");
}

function renderConnectivityTargets() {
  const options = [
    ...latestUpstreams.map((item) => ({
      value: `upstream:${item.id}`,
      label: `上游账号 · ${item.name}`,
    })),
    ...latestManagedAccounts.map((item) => ({
      value: `managed_account:${item.id}`,
      label: `官方账号 · ${item.name}`,
    })),
  ];

  if (!options.length) {
    connectivityTargetSelect.innerHTML = '<option value="">暂无可测试账号</option>';
    return;
  }

  const currentValue = connectivityTargetSelect.value;
  connectivityTargetSelect.innerHTML = options
    .map((option) => `<option value="${escapeHtml(option.value)}">${escapeHtml(option.label)}</option>`)
    .join("");

  if (options.some((option) => option.value === currentValue)) {
    connectivityTargetSelect.value = currentValue;
  }
}

function renderProxyTargetControls() {
  const options = [
    { value: "auto", label: "自动选择（默认上游 + 故障切换）" },
    ...latestUpstreams.map((item) => ({
      value: `upstream:${item.id}`,
      label: `上游账号 · ${item.name}`,
    })),
    ...latestManagedAccounts.map((item) => ({
      value: `managed_account:${item.id}`,
      label: `官方账号 · ${item.name}`,
    })),
  ];

  proxyTargetSelect.innerHTML = options
    .map((option) => `<option value="${escapeHtml(option.value)}">${escapeHtml(option.label)}</option>`)
    .join("");

  const selectedValue =
    latestProxyTarget.targetType === "auto"
      ? "auto"
      : `${latestProxyTarget.targetType}:${latestProxyTarget.targetId}`;

  proxyTargetSelect.value = options.some((option) => option.value === selectedValue) ? selectedValue : "auto";

  proxyTargetStatus.innerHTML = `
    <strong>${escapeHtml(latestProxyTarget.label)}</strong>
    <p>${escapeHtml(latestProxyTarget.description)}</p>
  `;
}

function buildAccountRows() {
  const upstreamRows = latestUpstreams.map((upstream) => {
    const status = statusMeta(upstream);
    const currentProxy = isCurrentProxyTarget("upstream", upstream.id);

    return {
      targetType: "upstream",
      id: upstream.id,
      searchText: [upstream.name, upstream.baseUrl, upstream.provider, upstream.apiKeyMasked].join(" ").toLowerCase(),
      kindLabel: "上游账号",
      routeLabel: currentProxy ? "当前代理" : upstream.isDefault ? "默认上游" : "候选账号",
      routeClass: currentProxy ? "route" : upstream.isDefault ? "default" : "kind",
      status,
      filterState: currentProxy ? "active" : status.stateKey,
      name: upstream.name,
      secondary: upstream.baseUrl,
      typeMarkup: `
        <div class="badge-row">
          <span class="badge kind">上游</span>
          <span class="badge">${escapeHtml(upstream.provider)}</span>
          ${upstream.isDefault ? '<span class="badge default">default</span>' : ""}
        </div>
      `,
      statusMarkup: `
        <div class="badge-row">
          <span class="badge ${status.className}">${escapeHtml(status.label)}</span>
          <span class="badge ${currentProxy ? "route" : upstream.isDefault ? "default" : "kind"}">${escapeHtml(
            currentProxy ? "当前代理中" : upstream.isDefault ? "默认路由" : "可选",
          )}</span>
        </div>
        <div class="table-meta">${escapeHtml(upstream.lastError || "最近没有错误")}</div>
      `,
      usageMarkup: upstreamUsageMarkup(latestUsageWindows.upstreams?.[upstream.id]),
      metaMarkup: `
        <div class="table-meta">Priority ${escapeHtml(upstream.priority)} / Failures ${escapeHtml(upstream.failureCount)}</div>
        <div class="table-meta">Key ${escapeHtml(upstream.apiKeyMasked)}</div>
      `,
      actionsMarkup: `
        <div class="action-row">
          <button class="button secondary mini" data-action="use-now" data-target-type="upstream" data-target-id="${upstream.id}" ${
            currentProxy ? "disabled" : ""
          }>设为当前代理</button>
          <button class="button secondary mini" data-action="test-connectivity" data-target-type="upstream" data-target-id="${upstream.id}">测试</button>
          <button class="button ghost mini" data-action="set-default" data-target-type="upstream" data-target-id="${upstream.id}">设为默认</button>
          <button class="button ghost mini" data-action="toggle-enabled" data-target-type="upstream" data-target-id="${upstream.id}">${
            upstream.enabled ? "禁用" : "启用"
          }</button>
        </div>
        <label class="switch">
          <input
            type="checkbox"
            data-action="toggle-schedule"
            data-target-type="upstream"
            data-target-id="${upstream.id}"
            ${upstream.scheduleEnabled ? "checked" : ""}
          />
          <span>调度</span>
        </label>
      `,
    };
  });

  const managedRows = latestManagedAccounts.map((account) => {
    const status = statusMeta(account);
    const currentProxy = isCurrentProxyTarget("managed_account", account.id);

    return {
      targetType: "managed_account",
      id: account.id,
      searchText: [
        account.name,
        account.email || "",
        account.planType || "",
        account.authType || "",
        account.accessTokenMasked || "",
      ].join(" ").toLowerCase(),
      kindLabel: "官方账号",
      routeLabel: currentProxy ? "当前代理" : "可选账号",
      routeClass: currentProxy ? "route" : "kind",
      status,
      filterState: currentProxy ? "active" : status.stateKey,
      name: account.name,
      secondary: account.email || "未解析到邮箱",
      typeMarkup: `
        <div class="badge-row">
          <span class="badge kind">官方</span>
          <span class="badge">${escapeHtml(account.planType || "unknown")}</span>
          <span class="badge">${escapeHtml(account.authType || "oauth")}</span>
        </div>
      `,
      statusMarkup: `
        <div class="badge-row">
          <span class="badge ${status.className}">${escapeHtml(status.label)}</span>
          <span class="badge ${currentProxy ? "route" : "kind"}">${escapeHtml(currentProxy ? "当前代理中" : "可选")}</span>
        </div>
        <div class="table-meta">${escapeHtml(account.lastError || `账号更新时间 ${formatTime(account.updatedAt)}`)}</div>
      `,
      usageMarkup: managedUsageMarkup(latestUsageWindows.managedAccounts?.[account.id]),
      metaMarkup: `
        <div class="table-meta">Auth ${escapeHtml(account.authType)} / ${escapeHtml(formatUnix(account.expiresAt))}</div>
        <div class="table-meta">AT ${escapeHtml(account.accessTokenMasked || "-")}</div>
        <div class="table-meta">RT ${escapeHtml(account.refreshTokenMasked || "-")}</div>
      `,
      actionsMarkup: `
        <div class="action-row">
          <button class="button secondary mini" data-action="use-now" data-target-type="managed_account" data-target-id="${account.id}" ${
            currentProxy ? "disabled" : ""
          }>设为当前代理</button>
          <button class="button secondary mini" data-action="test-connectivity" data-target-type="managed_account" data-target-id="${account.id}">测试</button>
          <button class="button ghost mini" data-action="toggle-enabled" data-target-type="managed_account" data-target-id="${account.id}">${
            account.enabled ? "停用" : "启用"
          }</button>
        </div>
        <label class="switch">
          <input
            type="checkbox"
            data-action="toggle-schedule"
            data-target-type="managed_account"
            data-target-id="${account.id}"
            ${account.scheduleEnabled ? "checked" : ""}
          />
          <span>调度</span>
        </label>
      `,
    };
  });

  return [...managedRows, ...upstreamRows];
}

function applyAccountFilters(rows) {
  const search = accountSearchInput.value.trim().toLowerCase();
  const kind = accountKindFilter.value;
  const state = accountStateFilter.value;

  return rows.filter((row) => {
    if (kind !== "all" && row.targetType !== kind) {
      return false;
    }

    if (state !== "all" && row.filterState !== state) {
      return false;
    }

    if (search && !row.searchText.includes(search)) {
      return false;
    }

    return true;
  });
}

function renderAccountsTable() {
  const rows = applyAccountFilters(buildAccountRows());

  if (!rows.length) {
    accountsWorkspace.innerHTML = '<p class="empty">没有匹配的账号。</p>';
    return;
  }

  accountsWorkspace.innerHTML = `
    <table>
      <thead>
        <tr>
          <th>账号</th>
          <th>类型</th>
          <th>状态</th>
          <th>配额 / 用量</th>
          <th>策略</th>
          <th>操作</th>
        </tr>
      </thead>
      <tbody>
        ${rows
          .map(
            (row) => `
              <tr>
                <td class="account-cell">
                  <div class="account-primary">
                    <strong>${escapeHtml(row.name)}</strong>
                    <span class="badge ${row.routeClass}">${escapeHtml(row.routeLabel)}</span>
                  </div>
                  <div class="account-meta">${escapeHtml(row.secondary)}</div>
                </td>
                <td>${row.typeMarkup}</td>
                <td>${row.statusMarkup}</td>
                <td>${row.usageMarkup}</td>
                <td>${row.metaMarkup}</td>
                <td>${row.actionsMarkup}</td>
              </tr>
            `,
          )
          .join("")}
      </tbody>
    </table>
  `;
}

function renderUsage(rows) {
  if (!rows.length) {
    usageContainer.innerHTML = '<p class="empty">还没有统计数据。</p>';
    return;
  }

  usageContainer.innerHTML = `
    <table>
      <thead>
        <tr>
          <th>Time</th>
          <th>账号</th>
          <th>Path</th>
          <th>Model</th>
          <th>Status</th>
          <th>Input</th>
          <th>Output</th>
          <th>Total</th>
          <th>Cost</th>
          <th>Latency</th>
        </tr>
      </thead>
      <tbody>
        ${rows
          .map(
            (row) => `
              <tr>
                <td>${escapeHtml(new Date(row.timestamp).toLocaleString())}</td>
                <td>${escapeHtml(row.targetName)}<div class="table-meta">${escapeHtml(row.targetType)}</div></td>
                <td class="mono">${escapeHtml(row.path)}</td>
                <td>${escapeHtml(row.model || "-")}</td>
                <td>${escapeHtml(row.statusCode)}</td>
                <td>${escapeHtml(number(row.inputTokens))}</td>
                <td>${escapeHtml(number(row.outputTokens))}</td>
                <td>${escapeHtml(number(row.totalTokens))}</td>
                <td>${escapeHtml(currency(row.cost))}</td>
                <td>${escapeHtml(row.latencyMs)} ms</td>
              </tr>
            `,
          )
          .join("")}
      </tbody>
    </table>
  `;
}

function renderConnectivityResult(result, errorMessage = "") {
  if (errorMessage) {
    connectivityResult.innerHTML = `
      <strong class="danger-text">测试失败</strong>
      <p class="danger-text">${escapeHtml(errorMessage)}</p>
    `;
    return;
  }

  if (!result) {
    connectivityResult.innerHTML = `
      <strong>等待测试</strong>
      <p>选择一个账号后开始测试。上游账号会探测 \`/models\`，官方账号会探测 \`chatgpt.com/backend-api/codex/responses\`。</p>
    `;
    return;
  }

  connectivityResult.innerHTML = `
    <strong class="${result.ok ? "" : "danger-text"}">${result.ok ? "测试成功" : "测试失败"}</strong>
    <p>${escapeHtml(result.targetName)} · ${escapeHtml(result.summary)}</p>
    <p class="mono">Endpoint: ${escapeHtml(result.endpoint)}</p>
    <p>Status: ${escapeHtml(result.statusCode ?? "-")} · Latency: ${escapeHtml(result.latencyMs)} ms</p>
    <textarea rows="5" readonly>${escapeHtml(result.snippet || "(empty body)")}</textarea>
  `;
}

async function setProxyTarget(targetType, targetId = null) {
  await request("/api/proxy-target", {
    method: "POST",
    body: JSON.stringify({ targetType, targetId }),
  });
  await refresh();
}

async function runConnectivityTest(targetType, targetId) {
  try {
    renderConnectivityResult({
      ok: true,
      targetName: "联通性测试进行中",
      summary: "正在请求目标账号，请稍候。",
      endpoint: "-",
      statusCode: null,
      latencyMs: 0,
      snippet: "",
    });

    connectivityTargetSelect.value = `${targetType}:${targetId}`;

    const payload = await request("/api/connectivity/test", {
      method: "POST",
      body: JSON.stringify({ targetType, targetId: Number(targetId) }),
    });

    renderConnectivityResult(payload.result);
    if (targetType === "managed_account") {
      await refresh({ forceUsageRefresh: true });
    }
  } catch (error) {
    renderConnectivityResult(null, error.message);
  }
}

async function refresh(options = {}) {
  const refreshQuery = options.forceUsageRefresh ? "?refresh=1" : "";
  const [health, summaryPayload, upstreamPayload, managedAccountPayload, usagePayload, usageWindowsPayload, proxyTargetPayload] = await Promise.all([
    request("/api/health"),
    request("/api/summary"),
    request("/api/upstreams"),
    request("/api/openai/accounts"),
    request("/api/usage"),
    request(`/api/account-usage-windows${refreshQuery}`),
    request("/api/proxy-target"),
  ]);

  healthDot.classList.toggle("live", health.status === "ok");
  latestUpstreams = upstreamPayload.upstreams;
  latestManagedAccounts = managedAccountPayload.accounts;
  latestUsageWindows = usageWindowsPayload.usageWindows || { upstreams: {}, managedAccounts: {} };
  latestProxyTarget = proxyTargetPayload.proxyTarget || latestProxyTarget;

  renderSummary(summaryPayload.summary);
  renderConnectivityTargets();
  renderProxyTargetControls();
  renderAccountsTable();
  renderUsage(usagePayload.usage);
}

function setOAuthStatus(message, isError = false) {
  oauthStatus.textContent = message;
  oauthStatus.classList.toggle("danger-text", isError);
}

async function syncDetectedCallback() {
  try {
    const payload = await fetchCallbackCache();
    useDetectedCallbackButton.classList.toggle("hidden", !payload?.value);
  } catch {
    useDetectedCallbackButton.classList.add("hidden");
  }
}

function openOAuthModal() {
  oauthModal.classList.remove("hidden");
  setOAuthStatus("先生成授权链接，再在浏览器里完成授权。");
  syncDetectedCallback();
}

function closeOAuthModal() {
  oauthModal.classList.add("hidden");
}

function openUpstreamForm() {
  upstreamFormPanel.classList.remove("hidden");
}

function closeUpstreamForm() {
  upstreamFormPanel.classList.add("hidden");
}

function setAuthMode(mode) {
  document.querySelectorAll(".auth-mode-tab").forEach((button) => {
    button.classList.toggle("active", button.dataset.authMode === mode);
    button.classList.toggle("secondary", button.dataset.authMode === mode);
    button.classList.toggle("ghost", button.dataset.authMode !== mode);
  });
  document.querySelector("#oauth-manual-pane").classList.toggle("hidden", mode !== "manual");
  document.querySelector("#oauth-refresh-pane").classList.toggle("hidden", mode !== "refresh_token");
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const formData = new FormData(form);
  const rawPricing = String(formData.get("pricingRules") || "").trim();
  await request("/api/upstreams", {
    method: "POST",
    body: JSON.stringify({
      name: formData.get("name"),
      baseUrl: formData.get("baseUrl"),
      apiKey: formData.get("apiKey"),
      priority: Number(formData.get("priority") || 100),
      isDefault: formData.get("isDefault") === "on",
      pricingRules: rawPricing ? JSON.parse(rawPricing) : [],
    }),
  });
  form.reset();
  form.priority.value = 100;
  closeUpstreamForm();
  await refresh();
});

refreshButton.addEventListener("click", () => refresh({ forceUsageRefresh: true }));

applyProxyTargetButton.addEventListener("click", async () => {
  const selected = proxyTargetSelect.value;
  if (selected === "auto") {
    await setProxyTarget("auto", null);
    return;
  }

  const [targetType, rawId] = selected.split(":");
  await setProxyTarget(targetType, Number(rawId));
});

runConnectivityTestButton.addEventListener("click", async () => {
  const selected = connectivityTargetSelect.value;
  if (!selected) {
    renderConnectivityResult(null, "请先选择一个账号。");
    return;
  }

  const [targetType, rawId] = selected.split(":");
  await runConnectivityTest(targetType, Number(rawId));
});

openOAuthModalButton.addEventListener("click", openOAuthModal);
toggleUpstreamFormButton.addEventListener("click", openUpstreamForm);
closeUpstreamFormButton.addEventListener("click", closeUpstreamForm);

document.querySelectorAll("[data-close-modal='true']").forEach((node) => {
  node.addEventListener("click", closeOAuthModal);
});

document.querySelectorAll(".auth-mode-tab").forEach((button) => {
  button.addEventListener("click", () => {
    setAuthMode(button.dataset.authMode);
  });
});

[accountSearchInput, accountKindFilter, accountStateFilter].forEach((node) => {
  node.addEventListener(node === accountSearchInput ? "input" : "change", () => {
    renderAccountsTable();
  });
});

accountsWorkspace.addEventListener("click", async (event) => {
  const actionNode = event.target.closest("[data-action]");
  if (!actionNode) {
    return;
  }

  const { action, targetType, targetId } = actionNode.dataset;
  const id = Number(targetId);

  if (!action || !targetType || !Number.isFinite(id)) {
    return;
  }

  if (action === "use-now") {
    await setProxyTarget(targetType, id);
    return;
  }

  if (action === "test-connectivity") {
    await runConnectivityTest(targetType, id);
    return;
  }

  if (action === "set-default" && targetType === "upstream") {
    await request(`/api/upstreams/${id}/default`, { method: "POST" });
    await refresh();
    return;
  }

  if (action === "toggle-enabled") {
    if (targetType === "upstream") {
      const upstream = latestUpstreams.find((item) => item.id === id);
      if (!upstream) {
        return;
      }
      await request(`/api/upstreams/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ enabled: !upstream.enabled }),
      });
    } else {
      const account = latestManagedAccounts.find((item) => item.id === id);
      if (!account) {
        return;
      }
      await request(`/api/openai/accounts/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ enabled: !account.enabled }),
      });
    }
    await refresh();
  }
});

accountsWorkspace.addEventListener("change", async (event) => {
  const actionNode = event.target.closest("[data-action='toggle-schedule']");
  if (!actionNode) {
    return;
  }

  const { targetType, targetId } = actionNode.dataset;
  const id = Number(targetId);
  if (!targetType || !Number.isFinite(id)) {
    return;
  }

  if (targetType === "upstream") {
    await request(`/api/upstreams/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ scheduleEnabled: event.target.checked }),
    });
  } else {
    await request(`/api/openai/accounts/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ scheduleEnabled: event.target.checked }),
    });
  }

  await refresh();
});

useDetectedCallbackButton.addEventListener("click", () => {
  fetchCallbackCache()
    .then((payload) => {
      if (!payload?.value) {
        return;
      }
      authCodeInput.value = payload.value;
      setOAuthStatus("已填入最近一次回调链接。");
    })
    .catch(() => {
      setOAuthStatus("没有可用的回调链接缓存。", true);
    });
});

generateAuthLinkButton.addEventListener("click", async () => {
  try {
    const payload = await request("/api/openai/oauth/generate-auth-url", {
      method: "POST",
      body: JSON.stringify({}),
    });
    oauthSession = payload;
    authUrlOutput.value = payload.authUrl;
    openAuthLinkButton.href = payload.authUrl;
    openAuthLinkButton.classList.remove("hidden");
    setOAuthStatus("授权链接已生成。打开新标签页完成授权后，把回调链接或 code 粘贴回来。");
  } catch (error) {
    setOAuthStatus(error.message, true);
  }
});

completeAuthButton.addEventListener("click", async () => {
  if (!oauthSession?.sessionId || !oauthSession?.state) {
    setOAuthStatus("请先生成授权链接。", true);
    return;
  }

  try {
    const payload = await request("/api/openai/oauth/exchange-code", {
      method: "POST",
      body: JSON.stringify({
        sessionId: oauthSession.sessionId,
        state: oauthSession.state,
        code: authCodeInput.value,
        name: manualAccountNameInput.value.trim(),
      }),
    });
    setOAuthStatus(`授权完成，账号 ${payload.account.name} 已保存。`);
    authCodeInput.value = "";
    manualAccountNameInput.value = "";
    await request("/api/openai/oauth/callback-cache", {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "",
    });
    await syncDetectedCallback();
    await refresh({ forceUsageRefresh: true });
  } catch (error) {
    setOAuthStatus(error.message, true);
  }
});

importRtButton.addEventListener("click", async () => {
  try {
    const payload = await request("/api/openai/oauth/import-refresh-token", {
      method: "POST",
      body: JSON.stringify({
        name: rtAccountNameInput.value.trim(),
        clientId: rtClientIdInput.value.trim(),
        refreshToken: rtInput.value,
      }),
    });
    setOAuthStatus(`RT 导入完成，账号 ${payload.account.name} 已保存。`);
    rtAccountNameInput.value = "";
    rtClientIdInput.value = "";
    rtInput.value = "";
    await refresh({ forceUsageRefresh: true });
  } catch (error) {
    setOAuthStatus(error.message, true);
  }
});

setAuthMode("manual");
syncDetectedCallback();
renderConnectivityResult(null);

refresh().catch((error) => {
  console.error(error);
  alert(error.message);
});

setInterval(() => {
  refresh().catch(() => {});
}, 15000);
