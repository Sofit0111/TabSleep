const MEMORY_PER_TAB_MB = 70;
const AUTO_SLEEP_ALARM = "autoSleepTabs";
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
const BLOCKED_URL_PREFIXES = ["chrome://", "chrome-extension://", "devtools://", "edge://"];
const CONTEXT_SLEEP_TAB = "sleep-this-tab";
const CONTEXT_WHITELIST_DOMAIN = "whitelist-this-domain";

chrome.runtime.onInstalled.addListener(async () => {
  await migrateLocalSettingsToSync();
  const settings = await getSyncSettings();
  await chrome.storage.local.get(DEFAULT_LOCAL_STATS).then((stats) => chrome.storage.local.set({ ...DEFAULT_LOCAL_STATS, ...stats }));
  await createContextMenus();
  await scheduleAutoSleep(settings.autoSleepMinutes);
});

chrome.runtime.onStartup.addListener(async () => {
  const settings = await getSyncSettings();
  await createContextMenus();
  await scheduleAutoSleep(settings.autoSleepMinutes);
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  // Исправление бага: пересоздаем таймер только если значение минут ФАКТИЧЕСКИ изменилось
  if (areaName === "sync" && changes.autoSleepMinutes) {
    if (changes.autoSleepMinutes.newValue !== changes.autoSleepMinutes.oldValue) {
      scheduleAutoSleep(changes.autoSleepMinutes.newValue);
    }
  }
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === AUTO_SLEEP_ALARM) {
    discardInactiveTabs();
  }
});

chrome.commands.onCommand.addListener((command) => {
  if (command === "discard-current-tab") discardCurrentTab();
  if (command === "discard-inactive-tabs") discardInactiveTabs();
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  handleContextMenu(info, tab);
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message)
    .then(sendResponse)
    .catch((error) => sendResponse({ error: error.message || "Unknown error" }));
  return true;
});

async function handleMessage(message) {
  if (message?.action === "discardCurrent") return { count: await discardCurrentTab() };
  if (message?.action === "discardInactive") return { count: await discardInactiveTabs() };
  if (message?.action === "discardTab") return { count: await discardTabById(message.tabId) };
  if (message?.action === "wakeAll") return { count: await wakeAllTabs() };
  if (message?.action === "wakeTab") return { count: await wakeTabById(message.tabId) };
  if (message?.action === "closeTab") {
    await chrome.tabs.remove(message.tabId);
    return { count: 1 };
  }
  if (message?.action === "saveSession") return { count: await saveCurrentSession() };
  if (message?.action === "restoreSession") return { count: await restoreSession(message.sessionId) };
  throw new Error("Unsupported action");
}

async function getSyncSettings() {
  return chrome.storage.sync.get(DEFAULT_SYNC_SETTINGS);
}

async function getLocalStats() {
  return chrome.storage.local.get(DEFAULT_LOCAL_STATS);
}

async function migrateLocalSettingsToSync() {
  const [syncSettings, localSettings] = await Promise.all([
    chrome.storage.sync.get(DEFAULT_SYNC_SETTINGS),
    chrome.storage.local.get({ autoSleepMinutes: null, whitelist: null, theme: null })
  ]);
  const migrated = { ...DEFAULT_SYNC_SETTINGS, ...syncSettings };
  if (localSettings.autoSleepMinutes !== null) migrated.autoSleepMinutes = Number(localSettings.autoSleepMinutes) || DEFAULT_SYNC_SETTINGS.autoSleepMinutes;
  if (Array.isArray(localSettings.whitelist) && localSettings.whitelist.length > 0) migrated.whitelist = localSettings.whitelist;
  if (localSettings.theme === "dark" || localSettings.theme === "light") migrated.theme = localSettings.theme;
  await chrome.storage.sync.set(migrated);
}

async function scheduleAutoSleep(minutes) {
  await chrome.alarms.clear(AUTO_SLEEP_ALARM);
  const periodInMinutes = Number(minutes);
  if (Number.isFinite(periodInMinutes) && periodInMinutes > 0) {
    chrome.alarms.create(AUTO_SLEEP_ALARM, {
      delayInMinutes: periodInMinutes,
      periodInMinutes
    });
  }
}

async function createContextMenus() {
  await chrome.contextMenus.removeAll();
  chrome.contextMenus.create({ id: CONTEXT_SLEEP_TAB, title: "Усыпить эту вкладку", contexts: ["page"] });
  chrome.contextMenus.create({ id: CONTEXT_WHITELIST_DOMAIN, title: "Добавить домен в белый список", contexts: ["page", "link"] });
}

async function handleContextMenu(info, tab) {
  if (info.menuItemId === CONTEXT_SLEEP_TAB && tab?.id) await discardTabById(tab.id);
  if (info.menuItemId === CONTEXT_WHITELIST_DOMAIN) {
    const sourceUrl = info.linkUrl || info.pageUrl || tab?.url || "";
    const domain = getDomain(sourceUrl);
    if (domain) await addDomainToWhitelist(domain);
  }
}

async function addDomainToWhitelist(domain) {
  const settings = await getSyncSettings();
  const normalized = normalizeDomain(domain);
  const whitelist = Array.from(new Set([...(settings.whitelist || []), normalized])).filter(Boolean);
  await chrome.storage.sync.set({ whitelist });
}

async function discardCurrentTab() {
  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!activeTab) return 0;
  return discardTabs([activeTab], { allowActive: true });
}

async function discardTabById(tabId) {
  const tab = await chrome.tabs.get(tabId);
  return discardTabs([tab], { allowActive: true });
}

async function discardInactiveTabs() {
  const settings = await getSyncSettings();
  const tabs = await chrome.tabs.query({});
  const now = Date.now();
  const sleepMs = (settings.autoSleepMinutes || 0) * 60 * 1000;

  const candidates = tabs.filter((tab) => {
    if (!isDiscardCandidate(tab, settings.whitelist, settings)) return false;
    // Мягкое автоусыпление: проверяем реальное время последнего доступа к вкладке
    if (sleepMs > 0 && tab.lastAccessed) {
      return (now - tab.lastAccessed) >= sleepMs;
    }
    return true; // Fallback, если lastAccessed недоступен
  });
  return discardTabs(candidates);
}

async function discardTabs(tabs, options = {}) {
  const settings = await getSyncSettings();
  let count = 0;

  for (const tab of tabs) {
    try {
      if (!isDiscardCandidate(tab, settings.whitelist, settings, options)) continue;

      const pageState = await inspectTabBeforeDiscard(tab.id, settings.activeProfile);
      if (pageState.hasUnsavedText || pageState.hasMediaContent) continue;
      if (settings.activeProfile === "reading" && pageState.hasLongTextContent) continue;

      if (tab.active) {
        await moveFocusAwayFromTab(tab);
        // Небольшая задержка, чтобы Chrome успел физически переключить UI
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      await chrome.tabs.discard(tab.id);
      count += 1;
    } catch (error) {
      console.warn("Unable to discard tab", tab.id, error);
    }
  }

  if (count > 0) await addSavedMemory(count * MEMORY_PER_TAB_MB);
  return count;
}

async function inspectTabBeforeDiscard(tabId, activeProfile) {
  try {
    const [result] = await chrome.scripting.executeScript({
      target: { tabId },
      func: (profile) => {
        const textInputs = Array.from(document.querySelectorAll("textarea, input[type='text'], input:not([type])"));
        const hasUnsavedText = textInputs.some((element) => {
          const value = typeof element.value === "string" ? element.value.trim() : "";
          return value.length > 0 && !element.disabled && !element.readOnly;
        });
        
        // Защита плееров (пауза или активные)
        const hasMediaContent = document.querySelectorAll("video, audio").length > 0;
        
        const bodyText = document.body?.innerText || "";
        const paragraphs = document.querySelectorAll("article p, main p, p").length;
        const hasLongTextContent = profile === "reading" && bodyText.length > 7000 && paragraphs >= 8;
        
        return { hasUnsavedText, hasLongTextContent, hasMediaContent };
      },
      args: [activeProfile]
    });
    // Если скрипт отработал, но вернул null (редкий баг Chrome), перестраховываемся
    return result?.result || { hasUnsavedText: true, hasLongTextContent: true, hasMediaContent: true };
  } catch (error) {
    // Если страница about:blank, не загружена или это системный URL — не трогаем её
    return { hasUnsavedText: true, hasLongTextContent: true, hasMediaContent: true };
  }
}

async function moveFocusAwayFromTab(tab) {
  const tabsInWindow = await chrome.tabs.query({ windowId: tab.windowId });
  const fallback = tabsInWindow.find((candidate) => candidate.id !== tab.id && !candidate.discarded);
  if (fallback?.id) {
    await chrome.tabs.update(fallback.id, { active: true });
    return;
  }
  await chrome.tabs.create({ active: true, windowId: tab.windowId });
}

async function wakeAllTabs() {
  const tabs = (await chrome.tabs.query({})).filter((tab) => tab.discarded);
  let count = 0;
  for (const tab of tabs) count += await wakeTab(tab);
  return count;
}

async function wakeTabById(tabId) {
  const tab = await chrome.tabs.get(tabId);
  return wakeTab(tab);
}

async function wakeTab(tab) {
  try {
    if (!tab.id || !isAllowedUrl(tab.url) || !tab.discarded) return 0;
    await chrome.tabs.reload(tab.id);
    return 1;
  } catch (error) {
    console.warn("Unable to wake tab", tab.id, error);
    return 0;
  }
}

async function saveCurrentSession() {
  const tabs = await chrome.tabs.query({});
  const sessionTabs = tabs
    .filter((tab) => tab.url && isAllowedUrl(tab.url))
    .map((tab) => ({ url: tab.url, title: tab.title || tab.url, pinned: Boolean(tab.pinned) }));
  const tabIdsToClose = tabs
    .filter((tab) => tab.id && tab.url && isAllowedUrl(tab.url))
    .map((tab) => tab.id);

  if (sessionTabs.length === 0) return 0;

  const stats = await getLocalStats();
  const savedSessions = Array.isArray(stats.savedSessions) ? stats.savedSessions : [];
  const session = { id: String(Date.now()), createdAt: new Date().toISOString(), tabs: sessionTabs };

  await chrome.storage.local.set({ savedSessions: [session, ...savedSessions].slice(0, 12) });
  await chrome.tabs.remove(tabIdsToClose);
  return sessionTabs.length;
}

async function restoreSession(sessionId) {
  const stats = await getLocalStats();
  const savedSessions = Array.isArray(stats.savedSessions) ? stats.savedSessions : [];
  const session = savedSessions.find((item) => item.id === sessionId) || savedSessions[0];
  if (!session) return 0;
  for (const tab of session.tabs) {
    await chrome.tabs.create({ url: tab.url, pinned: Boolean(tab.pinned), active: false });
  }
  return session.tabs.length;
}

async function addSavedMemory(amount) {
  const stats = await getLocalStats();
  const today = getTodayKey();
  const memoryHistory = { ...(stats.memoryHistory || {}) };
  memoryHistory[today] = Math.max(0, Number(memoryHistory[today] || 0) + amount);

  await chrome.storage.local.set({
    savedMemoryMb: Math.max(0, Number(stats.savedMemoryMb || 0) + amount),
    memoryHistory
  });
}

function isDiscardCandidate(tab, whitelist, settings, options = {}) {
  if (!tab?.id || tab.discarded || tab.pinned || tab.audible) return false;
  if (!options.allowActive && tab.active) return false;
  if (!isAllowedUrl(tab.url) || isWhitelisted(tab.url, whitelist)) return false;
  if (settings.activeProfile === "reading" && tab.active) return false;
  return true;
}

function isAllowedUrl(url = "") {
  return !BLOCKED_URL_PREFIXES.some((prefix) => url.startsWith(prefix));
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

function getTodayKey() {
  return new Date().toISOString().slice(0, 10);
}