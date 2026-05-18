const PROFILE_TIMERS = {
  aggressive: 3,
  balanced: 20,
  reading: 20
};
const DEFAULT_SYNC_SETTINGS = {
  autoSleepMinutes: PROFILE_TIMERS.balanced,
  activeProfile: "balanced",
  profiles: {
    aggressive: { label: "Агрессивный", minutes: PROFILE_TIMERS.aggressive },
    balanced: { label: "Баланс", minutes: PROFILE_TIMERS.balanced },
    reading: { label: "Режим чтения", minutes: PROFILE_TIMERS.reading }
  },
  whitelist: [],
  theme: "light"
};
const DEFAULT_LOCAL_STATS = {
  savedMemoryMb: 0,
  memoryHistory: {},
  savedSessions: []
};

const form = document.getElementById("optionsForm");
const profileSelect = document.getElementById("profileSelect");
const timerInput = document.getElementById("autoSleepMinutes");
const whitelistInput = document.getElementById("whitelist");
const themeSelect = document.getElementById("themeSelect");
const themeToggle = document.getElementById("themeToggle");
const statusText = document.getElementById("optionsStatus");
const sessionsHint = document.getElementById("sessionsHint");
const sessionsList = document.getElementById("sessionsList");

document.addEventListener("DOMContentLoaded", loadOptions);
form.addEventListener("submit", saveOptions);
themeToggle.addEventListener("click", toggleTheme);
themeSelect.addEventListener("change", () => applyTheme(themeSelect.value));
profileSelect.addEventListener("change", applyProfileTimer);
sessionsList.addEventListener("click", restoreSessionFromList);

async function loadOptions() {
  const [settings, stats] = await Promise.all([
    chrome.storage.sync.get(DEFAULT_SYNC_SETTINGS),
    chrome.storage.local.get(DEFAULT_LOCAL_STATS)
  ]);
  profileSelect.value = settings.activeProfile || "balanced";
  timerInput.value = String(settings.autoSleepMinutes);
  whitelistInput.value = Array.isArray(settings.whitelist) ? settings.whitelist.join("\n") : "";
  themeSelect.value = settings.theme === "dark" ? "dark" : "light";
  applyTheme(themeSelect.value);
  renderSessions(stats.savedSessions || []);
}

async function saveOptions(event) {
  event.preventDefault();
  const activeProfile = profileSelect.value;
  const autoSleepMinutes = clampNumber(timerInput.value, 0, 1440);
  const whitelist = parseWhitelist(whitelistInput.value);
  const theme = themeSelect.value === "dark" ? "dark" : "light";

  await chrome.storage.sync.set({
    activeProfile,
    autoSleepMinutes,
    whitelist,
    theme
  });

  timerInput.value = String(autoSleepMinutes);
  whitelistInput.value = whitelist.join("\n");
  applyTheme(theme);
  setStatus("Сохранено");
}

async function toggleTheme() {
  const nextTheme = themeSelect.value === "dark" ? "light" : "dark";
  themeSelect.value = nextTheme;
  applyTheme(nextTheme);
  await chrome.storage.sync.set({ theme: nextTheme });
  setStatus("Тема сохранена");
}

function applyProfileTimer() {
  const activeProfile = profileSelect.value;
  timerInput.value = String(PROFILE_TIMERS[activeProfile] ?? PROFILE_TIMERS.balanced);
}

function applyTheme(theme) {
  document.body.classList.toggle("dark", theme === "dark");
}

function renderSessions(sessions) {
  sessionsHint.textContent = String(sessions.length);
  sessionsList.innerHTML = sessions.length
    ? sessions.map((session) => {
      const date = new Date(session.createdAt);
      const label = Number.isNaN(date.getTime()) ? "Сессия" : date.toLocaleString("ru-RU");
      const count = Array.isArray(session.tabs) ? session.tabs.length : 0;
      return `
        <article class="session-row">
          <div>
            <div class="session-title">${escapeHtml(label)}</div>
            <div class="session-meta">${formatTabsLabel(count)}</div>
          </div>
          <button class="restore-button" type="button" data-session-id="${escapeAttribute(session.id)}">Восстановить</button>
        </article>
      `;
    }).join("")
    : `<div class="empty-state">Сохраненных сессий пока нет</div>`;
}

async function restoreSessionFromList(event) {
  const button = event.target.closest("button[data-session-id]");
  if (!button) {
    return;
  }
  button.disabled = true;
  try {
    const response = await chrome.runtime.sendMessage({
      action: "restoreSession",
      sessionId: button.dataset.sessionId
    });
    if (response?.error) {
      throw new Error(response.error);
    }
    setStatus(`Восстановлено вкладок: ${response?.count ?? 0}`);
  } catch (error) {
    setStatus(error.message || "Не удалось восстановить сессию");
  } finally {
    button.disabled = false;
  }
}

function clampNumber(value, min, max) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) {
    return DEFAULT_SYNC_SETTINGS.autoSleepMinutes;
  }
  return Math.min(Math.max(parsed, min), max);
}

function parseWhitelist(value) {
  return value
    .split(/\r?\n|,/)
    .map((item) => item.trim().toLowerCase())
    .map((item) => item.replace(/^https?:\/\//, "").replace(/^www\./, "").split("/")[0])
    .filter(Boolean)
    .filter((item, index, list) => list.indexOf(item) === index);
}

function formatTabsLabel(count) {
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod10 === 1 && mod100 !== 11) {
    return `${count} вкладка`;
  }
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) {
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

function setStatus(message) {
  statusText.textContent = message;
  window.clearTimeout(setStatus.timeoutId);
  setStatus.timeoutId = window.setTimeout(() => {
    statusText.textContent = "Настройки синхронизируются между устройствами";
  }, 2400);
}
