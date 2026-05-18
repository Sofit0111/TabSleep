const MEMORY_PER_TAB_MB = 70;
const RING_LENGTH = 314;
const PROFILE_TIMERS = {
  aggressive: 3,
  balanced: 20,
  reading: 20
};
const DEFAULT_SYNC_SETTINGS = {
  theme: "light",
  autoSleepMinutes: PROFILE_TIMERS.balanced,
  activeProfile: "balanced",
  profiles: {
    aggressive: { label: "Агрессивный", minutes: PROFILE_TIMERS.aggressive },
    balanced: { label: "Баланс", minutes: PROFILE_TIMERS.balanced },
    reading: { label: "Режим чтения", minutes: PROFILE_TIMERS.reading }
  },
  whitelist: []
};
const DEFAULT_LOCAL_STATS = {
  savedMemoryMb: 0,
  memoryHistory: {},
  savedSessions: []
};

const elements = {
  themeToggle: document.getElementById("themeToggle"),
  profileSelect: document.getElementById("profileSelect"),
  memorySaved: document.getElementById("memorySaved"),
  sleepingTabs: document.getElementById("sleepingTabs"),
  totalTabs: document.getElementById("totalTabs"),
  eligibleTabs: document.getElementById("eligibleTabs"),
  protectedTabs: document.getElementById("protectedTabs"),
  memoryRing: document.getElementById("memoryRing"),
  ringPercent: document.getElementById("ringPercent"),
  historyChart: document.getElementById("historyChart"),
  domainList: document.getElementById("domainList"),
  domainsHint: document.getElementById("domainsHint"),
  tabsList: document.getElementById("tabsList"),
  tabsHint: document.getElementById("tabsHint"),
  sleepCurrent: document.getElementById("sleepCurrent"),
  sleepInactive: document.getElementById("sleepInactive"),
  wakeAll: document.getElementById("wakeAll"),
  saveSession: document.getElementById("saveSession"),
  openOptions: document.getElementById("openOptions"),
  statusText: document.getElementById("statusText")
};

document.addEventListener("DOMContentLoaded", init);

async function init() {
  const settings = await getSyncSettings();
  applyTheme(settings.theme);
  elements.profileSelect.value = settings.activeProfile || "balanced";
  bindEvents();
  await refreshDashboard();
}

function bindEvents() {
  elements.themeToggle.addEventListener("click", toggleTheme);
  elements.profileSelect.addEventListener("change", updateProfile);
  elements.sleepCurrent.addEventListener("click", () => runAction("discardCurrent", "Текущая вкладка усыплена"));
  elements.sleepInactive.addEventListener("click", () => runAction("discardInactive", "Неактивные вкладки усыплены"));
  elements.wakeAll.addEventListener("click", () => runAction("wakeAll", "Вкладки пробуждаются"));
  elements.saveSession.addEventListener("click", () => runAction("saveSession", "Сессия сохранена"));
  elements.openOptions.addEventListener("click", () => chrome.runtime.openOptionsPage());
  elements.tabsList.addEventListener("click", handleTabAction);
}

async function getSyncSettings() {
  return chrome.storage.sync.get(DEFAULT_SYNC_SETTINGS);
}

async function getLocalStats() {
  return chrome.storage.local.get(DEFAULT_LOCAL_STATS);
}

async function toggleTheme() {
  const settings = await getSyncSettings();
  const nextTheme = settings.theme === "dark" ? "light" : "dark";
  await chrome.storage.sync.set({ theme: nextTheme });
  applyTheme(nextTheme);
}

async function updateProfile() {
  const activeProfile = elements.profileSelect.value;
  const autoSleepMinutes = PROFILE_TIMERS[activeProfile] ?? PROFILE_TIMERS.balanced;
  await chrome.storage.sync.set({ activeProfile, autoSleepMinutes });
  setStatus(`Профиль: ${getProfileLabel(activeProfile)}`);
}

function applyTheme(theme) {
  document.body.classList.toggle("dark", theme === "dark");
}

async function runAction(action, successMessage, payload = {}) {
  setBusy(true);
  setStatus("Выполняется...");
  try {
    const response = await chrome.runtime.sendMessage({ action, ...payload });
    if (response?.error) {
      throw new Error(response.error);
    }
    const count = response?.count ?? 0;
    setStatus(`${successMessage}: ${count}`);
    await refreshDashboard();
  } catch (error) {
    setStatus(error.message || "Ошибка выполнения");
  } finally {
    setBusy(false);
  }
}

async function refreshDashboard() {
  const [tabs, settings, stats] = await Promise.all([
    chrome.tabs.query({}),
    getSyncSettings(),
    getLocalStats()
  ]);
  const sleeping = tabs.filter((tab) => tab.discarded).length;
  const eligible = tabs.filter((tab) => isEligibleForDisplay(tab, settings.whitelist)).length;
  const protectedCount = Math.max(tabs.length - eligible, 0);
  const savedMemoryMb = Math.max(stats.savedMemoryMb || 0, sleeping * MEMORY_PER_TAB_MB);
  const percent = Math.min(Math.round((sleeping / Math.max(tabs.length, 1)) * 100), 100);

  elements.totalTabs.textContent = String(tabs.length);
  elements.eligibleTabs.textContent = String(eligible);
  elements.protectedTabs.textContent = String(protectedCount);
  elements.sleepingTabs.textContent = formatTabsLabel(sleeping);
  elements.memorySaved.textContent = formatMemory(savedMemoryMb);
  elements.ringPercent.textContent = `${percent}%`;
  elements.memoryRing.style.strokeDashoffset = String(RING_LENGTH - (RING_LENGTH * percent) / 100);
  elements.profileSelect.value = settings.activeProfile || "balanced";

  renderHistoryChart(stats.memoryHistory || {});
  renderDomainList(tabs);
  renderTabsList(tabs);
}

function renderHistoryChart(history) {
  const days = getLastSevenDays();
  const values = days.map((day) => Number(history[day.key] || 0));
  const max = Math.max(...values, MEMORY_PER_TAB_MB);
  const points = values.map((value, index) => {
    const x = 16 + index * 48;
    const y = 76 - (value / max) * 58;
    return { x, y, value, label: days[index].label };
  });
  const path = points.map((point, index) => `${index === 0 ? "M" : "L"} ${point.x} ${point.y}`).join(" ");
  const area = `${path} L ${points[points.length - 1].x} 82 L ${points[0].x} 82 Z`;

  elements.historyChart.innerHTML = `
    <line class="chart-grid" x1="12" y1="82" x2="308" y2="82"></line>
    <line class="chart-grid" x1="12" y1="22" x2="308" y2="22"></line>
    <path class="chart-area" d="${area}"></path>
    <path class="chart-line" d="${path}"></path>
    ${points.map((point) => `<circle class="chart-dot" cx="${point.x}" cy="${point.y}" r="4"><title>${point.label}: ${formatMemory(point.value)}</title></circle>`).join("")}
    ${points.map((point) => `<text x="${point.x}" y="94" text-anchor="middle" fill="currentColor" opacity="0.55" font-size="9">${point.label}</text>`).join("")}
  `;
}

function renderDomainList(tabs) {
  const grouped = new Map();
  for (const tab of tabs) {
    const domain = getDomain(tab.url) || "служебные страницы";
    grouped.set(domain, (grouped.get(domain) || 0) + 1);
  }
  const top = Array.from(grouped.entries()).sort((a, b) => b[1] - a[1]).slice(0, 4);
  elements.domainsHint.textContent = String(grouped.size);
  elements.domainList.innerHTML = top.length
    ? top.map(([domain, count], index) => `
      <div class="domain-row ${index === 0 && count > 1 ? "hot" : ""}">
        <div>
          <div class="domain-name">${escapeHtml(domain)}</div>
          <div class="domain-meta">${formatTabsLabelShort(count)}</div>
        </div>
        <div class="domain-count">${count}</div>
      </div>
    `).join("")
    : `<div class="empty-state">Открытых доменов нет</div>`;
}

function renderTabsList(tabs) {
  elements.tabsHint.textContent = String(tabs.length);
  elements.tabsList.innerHTML = tabs.map((tab) => {
    const domain = getDomain(tab.url) || "служебная вкладка";
    const favicon = tab.favIconUrl || "";
    const title = tab.title || tab.url || "Без названия";
    const sleepDisabled = tab.discarded || tab.pinned || tab.audible || !isAllowedUrl(tab.url);
    const wakeDisabled = !tab.discarded;
    return `
      <article class="tab-row ${tab.discarded ? "discarded" : ""}" data-tab-id="${tab.id}">
        ${favicon ? `<img class="tab-favicon" src="${escapeAttribute(favicon)}" alt="">` : `<span class="tab-favicon"></span>`}
        <div>
          <div class="tab-title" title="${escapeAttribute(title)}">${escapeHtml(title)}</div>
          <div class="tab-domain">${escapeHtml(domain)}</div>
        </div>
        <div class="tab-actions">
          <button class="mini-button" data-action="sleep" title="Усыпить" ${sleepDisabled ? "disabled" : ""}>S</button>
          <button class="mini-button" data-action="wake" title="Разбудить" ${wakeDisabled ? "disabled" : ""}>W</button>
          <button class="mini-button danger" data-action="close" title="Закрыть">×</button>
        </div>
      </article>
    `;
  }).join("");
}

async function handleTabAction(event) {
  const button = event.target.closest("button[data-action]");
  const row = event.target.closest(".tab-row");
  if (!button || !row) {
    return;
  }
  const tabId = Number(row.dataset.tabId);
  const action = button.dataset.action;
  if (action === "sleep") {
    await runAction("discardTab", "Вкладка усыплена", { tabId });
  }
  if (action === "wake") {
    await runAction("wakeTab", "Вкладка пробуждается", { tabId });
  }
  if (action === "close") {
    await runAction("closeTab", "Вкладка закрыта", { tabId });
  }
}

function isEligibleForDisplay(tab, whitelist) {
  return Boolean(tab.id)
    && !tab.active
    && !tab.pinned
    && !tab.audible
    && !tab.discarded
    && isAllowedUrl(tab.url)
    && !isWhitelisted(tab.url, whitelist);
}

function isAllowedUrl(url = "") {
  return !["chrome://", "chrome-extension://", "devtools://", "edge://"].some((prefix) => url.startsWith(prefix));
}

function isWhitelisted(url = "", whitelist = []) {
  const hostname = getDomain(url);
  return whitelist.some((domain) => {
    const normalized = normalizeDomain(domain);
    return normalized && (hostname === normalized || hostname.endsWith(`.${normalized}`));
  });
}

function getDomain(url = "") {
  try {
    return normalizeDomain(new URL(url).hostname);
  } catch {
    return "";
  }
}

function normalizeDomain(domain = "") {
  return String(domain).trim().toLowerCase().replace(/^www\./, "");
}

function getLastSevenDays() {
  const formatter = new Intl.DateTimeFormat("ru-RU", { weekday: "short" });
  return Array.from({ length: 7 }, (_, index) => {
    const date = new Date();
    date.setDate(date.getDate() - (6 - index));
    return {
      key: date.toISOString().slice(0, 10),
      label: formatter.format(date).replace(".", "")
    };
  });
}

function getProfileLabel(profile) {
  if (profile === "aggressive") {
    return "Агрессивный";
  }
  if (profile === "reading") {
    return "Режим чтения";
  }
  return "Баланс";
}

function formatMemory(value) {
  if (value >= 1024) {
    return `${(value / 1024).toFixed(1)} ГБ`;
  }
  return `${value} МБ`;
}

function formatTabsLabel(count) {
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod10 === 1 && mod100 !== 11) {
    return `${count} усыпленная вкладка`;
  }
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) {
    return `${count} усыпленные вкладки`;
  }
  return `${count} усыпленных вкладок`;
}

function formatTabsLabelShort(count) {
  if (count === 1) {
    return "1 вкладка";
  }
  if (count >= 2 && count <= 4) {
    return `${count} вкладки`;
  }
  return `${count} вкладок`;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#039;"
  })[char]);
}

function escapeAttribute(value) {
  return escapeHtml(value).replace(/`/g, "&#096;");
}

function setBusy(isBusy) {
  elements.sleepCurrent.disabled = isBusy;
  elements.sleepInactive.disabled = isBusy;
  elements.wakeAll.disabled = isBusy;
  elements.saveSession.disabled = isBusy;
}

function setStatus(message) {
  elements.statusText.textContent = message;
}
