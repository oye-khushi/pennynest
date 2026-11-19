/* ============================================================
   PennyNest — frontend application script (single file)
   Sections: 1) data layer & API client  2) render layer  3) actions
   All persistent data lives in D1 via /api. localStorage holds only
   the session token, the theme and the last visited page.
   ============================================================ */
/* ============================================================
   PENNYNEST — CLIENT DATA LAYER (API-BACKED, NO localStorage DATA)
   All user data lives in D1 on the server. localStorage keeps ONLY
   the session token, the chosen theme and the last visited page.
   ============================================================ */

const API_BASE = "/api";
const TOKEN_KEY = "pennynest_session_token";
const THEME_KEY = "pennynest_current_theme";
const PAGE_KEY = "pennynest_active_page";
const POLL_MS = 10000;

const pandaMoods = [
  "🐼 Munching bamboo on a mindful student budget...",
  "🐼 Guarding your pennies inside the cozy nest! 🏡",
  "🐼 Proud of you for tracking your campus expenses! 🌿",
  "🐼 Taking a cozy nap after counting your savings! 🎋",
  "🐼 Ready for an iced coffee treat—if the budget says yes! 🧋"
];
let currentMoodIndex = 0;
let pendingNestMembers = [];
let activeCozyNestId = null;
let currentAdminSubTab = "overview";

/** Single source of truth for everything the UI renders. */
const state = {
  token: localStorage.getItem(TOKEN_KEY) || null,
  user: null,
  transactions: [],
  budgets: {},
  goals: [],
  nests: [],
  inbox: [],
  unread: 0,
  directory: [],
  adminNests: [],
  adminGoals: [],
  categoryCounts: {},
  avatarMap: {},
  online: true,
  busy: false,
  pollTimer: null,
  chatSignature: "",
  inboxOpen: false
};

class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status || 0;
  }
}

/* ---------------- API client (one fetch wrapper) ---------------- */

async function api(path, options = {}) {
  const { method = "GET", body, raw = false, quiet = false } = options;
  const headers = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (state.token) headers["Authorization"] = "Bearer " + state.token;

  let res;
  try {
    res = await fetch(API_BASE + path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body)
    });
  } catch (err) {
    state.online = false;
    showStatusBanner("⚠️ Can't reach the PennyNest server. Check your connection — we'll keep trying.");
    throw new ApiError("Can't reach the PennyNest server right now.", 0);
  }

  if (!state.online) {
    state.online = true;
    hideStatusBanner();
  }

  if (raw) {
    if (!res.ok) throw new ApiError("The download could not be prepared.", res.status);
    return res;
  }

  if (res.status === 401 && state.token) {
    handleExpiredSession();
    throw new ApiError("Your session has expired. Please sign in again.", 401);
  }

  let payload = null;
  const text = await res.text();
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch (e) {
      payload = null;
    }
  }

  if (!res.ok) {
    const message = (payload && payload.error) || "Something went wrong. Please try again.";
    if (!quiet) console.warn("API error", method, path, res.status, message);
    throw new ApiError(message, res.status);
  }

  return payload;
}

function handleExpiredSession() {
  state.token = null;
  state.user = null;
  localStorage.removeItem(TOKEN_KEY);
  stopPolling();
  lockApp(false);
  showToast("🔐 Please sign in again — your session ended.");
}

function showStatusBanner(message) {
  const el = document.getElementById("appStatusBanner");
  if (!el) return;
  el.textContent = message;
  el.classList.remove("hidden");
}

function hideStatusBanner() {
  const el = document.getElementById("appStatusBanner");
  if (el) el.classList.add("hidden");
}

function setBusy(isBusy, label) {
  state.busy = isBusy;
  const loader = document.getElementById("globalLoader");
  const text = document.getElementById("globalLoaderText");
  if (loader) loader.classList.toggle("hidden", !isBusy);
  if (text && label) text.textContent = label;
  document.body.classList.toggle("is-busy", isBusy);
}

function isUserAdmin(user) {
  return Boolean(user && user.role === "admin");
}

function getCurrentUser() {
  return state.user;
}

/* ---------------- cache helpers used by render code ---------------- */

function getTransactions() {
  return state.transactions || [];
}

function getBudgets() {
  return state.budgets || {};
}

function getGoals() {
  return state.goals || [];
}

function getAllCozyNests() {
  return state.nests || [];
}

/** Directory-only lookup for admin screens (server never sends PINs). */
function getAllUsers() {
  return state.directory || [];
}

/** Original signature kept so old render code keeps working (scoped to cache). */
function getTransactionsForEmail(email) {
  if (state.user && String(email).toLowerCase() === state.user.email.toLowerCase()) return state.transactions;
  return [];
}

function getGoalsForEmail(email) {
  if (state.user && String(email).toLowerCase() === state.user.email.toLowerCase()) return state.goals;
  return state.adminGoals.filter((g) => g.email && g.email.toLowerCase() === String(email).toLowerCase());
}

function cacheAvatars() {
  const map = {};
  state.directory.forEach((u) => (map[u.email.toLowerCase()] = u.avatar || "🐼"));
  state.nests.forEach((n) => {
    const avatars = n.memberAvatars || {};
    Object.keys(avatars).forEach((email) => (map[email.toLowerCase()] = avatars[email] || "🐼"));
  });
  if (state.user) map[state.user.email.toLowerCase()] = state.user.avatar || "🐼";
  state.avatarMap = map;
}

/* ---------------- sync ---------------- */

async function syncAdminData() {
  if (!isUserAdmin(state.user)) {
    state.directory = [];
    state.adminNests = [];
    state.adminGoals = [];
    return;
  }
  const [usersRes, nestsRes, goalsRes, statsRes] = await Promise.all([
    api("/admin/users", { quiet: true }),
    api("/admin/nests", { quiet: true }),
    api("/admin/goals", { quiet: true }),
    api("/admin/stats", { quiet: true })
  ]);
  state.directory = usersRes.users || [];
  state.adminNests = nestsRes.nests || [];
  state.adminGoals = goalsRes.goals || [];
  state.categoryCounts = statsRes.categoryCounts || {};
}

async function syncAll(options = {}) {
  if (!state.token) return;
  const data = await api("/bootstrap", { quiet: Boolean(options.quiet) });
  state.user = data.user;
  state.transactions = data.transactions || [];
  state.budgets = data.budgets || {};
  state.goals = data.goals || [];
  state.nests = data.nests || [];
  state.inbox = (data.inbox && data.inbox.messages) || [];
  state.unread = (data.inbox && data.inbox.unread) || 0;
  await syncAdminData();
  cacheAvatars();
  renderInboxBadge();
  if (state.inboxOpen) renderInboxList();
  refreshAllViews();
  syncProfileAvatarUI(state.user);
}

/** Run a mutation, then reload from the server so every device stays identical. */
async function mutate(fn, successMessage) {
  try {
    const result = await fn();
    await syncAll({ quiet: true });
    if (successMessage) showToast(successMessage);
    return result;
  } catch (err) {
    showToast("⚠️ " + err.message);
    return undefined;
  }
}

/* ---------------- polling ---------------- */

function startPolling() {
  stopPolling();
  state.pollTimer = setInterval(async () => {
    if (!state.token || document.hidden || state.busy) return;
    try {
      await syncAll({ quiet: true });
    } catch (err) {
      /* banner already shown by api() */
    }
  }, POLL_MS);
}

function stopPolling() {
  if (state.pollTimer) clearInterval(state.pollTimer);
  state.pollTimer = null;
}

/* ---------------- auth ---------------- */

function configureAuthUI() {
  // "Login As" stays visible on the login form. Sign-up never offers a role:
  // the server alone decides who is an admin.
  const loginRoleGroup = document.getElementById("loginRoleGroup");
  const regRoleGroup = document.getElementById("regRoleGroup");
  if (loginRoleGroup) loginRoleGroup.classList.remove("hidden");
  if (regRoleGroup) regRoleGroup.classList.add("hidden");
}

function setAuthBusy(isBusy, label) {
  const loginBtn = document.querySelector("#loginForm button[type='submit']");
  const regBtn = document.querySelector("#registerForm button[type='submit']");
  [loginBtn, regBtn].forEach((btn) => {
    if (!btn) return;
    if (isBusy) {
      btn.dataset.originalText = btn.dataset.originalText || btn.textContent;
      btn.disabled = true;
    } else {
      btn.disabled = false;
      if (btn.dataset.originalText) btn.textContent = btn.dataset.originalText;
    }
  });
  if (isBusy && label && loginBtn && !loginBtn.closest(".hidden")) loginBtn.textContent = label;
  if (isBusy && label && regBtn && !regBtn.closest(".hidden")) regBtn.textContent = label;
}

async function handleRegisterUser(e) {
  e.preventDefault();
  const name = document.getElementById("regName").value.trim();
  const email = document.getElementById("regEmail").value.trim().toLowerCase();
  const pin = document.getElementById("regPin").value.trim();

  if (!name) return showToast("⚠️ Please enter your name.");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return showToast("⚠️ Please enter a valid email address.");
  if (!/^\d{4}$/.test(pin)) return showToast("⚠️ Your passcode must be exactly 4 digits.");

  setAuthBusy(true, "Creating your nest…");
  try {
    const data = await api("/auth/register", { method: "POST", body: { name, email, pin } });
    state.token = data.token;
    localStorage.setItem(TOKEN_KEY, data.token);
    document.getElementById("registerForm").reset();
    await syncAll();
    document.getElementById("welcomeScreen").style.display = "none";
    document.getElementById("mainNavbar").style.display = "block";
    launchApp(true);
    startPolling();
    showToast("🏡 Welcome to PennyNest!");
  } catch (err) {
    openCuteModal({
      icon: err.status === 409 ? "🐼" : "⚠️",
      title: err.status === 409 ? "Profile Already Exists" : "Could Not Create Profile",
      message: err.message,
      confirmText: err.status === 409 ? "Go to Log In 🔑" : "Okay",
      showCancel: false,
      onConfirm: err.status === 409 ? () => switchAuthMode("login") : null
    });
  } finally {
    setAuthBusy(false);
  }
}

async function handleLoginUser(e) {
  e.preventDefault();
  const email = document.getElementById("loginEmail").value.trim().toLowerCase();
  const pin = document.getElementById("loginPin").value.trim();

  if (!email || !/^\d{4}$/.test(pin)) return showToast("⚠️ Enter your email and 4-digit passcode.");

  setAuthBusy(true, "Unlocking…");
  try {
    const data = await api("/auth/login", { method: "POST", body: { email, pin } });
    const roleEl = document.getElementById("loginRole");
    const chosenRole = roleEl ? roleEl.value : "user";
    const actualRole = data.user && data.user.role === "admin" ? "admin" : "user";
    if (chosenRole !== actualRole) {
      // Wrong "Login As" choice: end the session we just opened and explain.
      state.token = data.token;
      try { await api("/auth/logout", { method: "POST", quiet: true }); } catch (_) {}
      state.token = null;
      openCuteModal({
        icon: "🔐",
        title: "Wrong Login Type",
        message: actualRole === "admin"
          ? "This is an Admin account. Please choose \"Admin\" in Login As."
          : "This is a Student account. Please choose \"Student User\" in Login As.",
        confirmText: "OK",
        showCancel: false,
        isDanger: true
      });
      return;
    }
    state.token = data.token;
    localStorage.setItem(TOKEN_KEY, data.token);
    document.getElementById("loginForm").reset();
    await syncAll();
    document.getElementById("welcomeScreen").style.display = "none";
    document.getElementById("mainNavbar").style.display = "block";
    launchApp(true);
    startPolling();
    showToast("🔓 Nest unlocked! Welcome back!");
  } catch (err) {
    if (err.status === 401) {
      openCuteModal({
        icon: "🔐",
        title: "Could Not Unlock",
        message: err.message,
        confirmText: "Retry",
        showCancel: false,
        isDanger: true
      });
      const pinEl = document.getElementById("loginPin");
      if (pinEl) pinEl.value = "";
    } else {
      showToast("⚠️ " + err.message);
    }
  } finally {
    setAuthBusy(false);
  }
}

function launchApp(forceDefaultHome = false) {
  const user = getCurrentUser();
  if (!user) return;

  document.getElementById("welcomeScreen").style.display = "none";
  document.getElementById("mainNavbar").style.display = "block";

  syncProfileAvatarUI(user);

  const adminNavBtn = document.getElementById("nav-adminCommandPage");
  const backToAdminBtn = document.getElementById("backToAdminCenterBtn");
  const aiChatSec = document.getElementById("studentAiChatSection");

  if (isUserAdmin(user)) {
    if (adminNavBtn) adminNavBtn.classList.remove("hidden");
    if (backToAdminBtn) backToAdminBtn.classList.remove("hidden");
  } else {
    if (adminNavBtn) adminNavBtn.classList.add("hidden");
    if (backToAdminBtn) backToAdminBtn.classList.add("hidden");
  }

  if (aiChatSec) aiChatSec.classList.remove("hidden");

  pendingNestMembers = [user.email];

  const defaultHome = isUserAdmin(user) ? "adminCommandPage" : "dashboardPage";
  let savedPage = localStorage.getItem(PAGE_KEY) || defaultHome;
  if (!isUserAdmin(user) && savedPage === "adminCommandPage") savedPage = "dashboardPage";
  if (savedPage === "inboxPage") savedPage = defaultHome;

  const targetPage = forceDefaultHome ? defaultHome : savedPage;

  initAiChatGreeting();
  openPage(targetPage);
  renderInboxBadge();
}

async function lockApp(callServer = true) {
  if (callServer && state.token) {
    try {
      await api("/auth/logout", { method: "POST", quiet: true });
    } catch (err) {
      /* ignore — local sign-out still happens */
    }
  }
  stopPolling();
  localStorage.removeItem(TOKEN_KEY);
  state.token = null;
  state.user = null;
  state.transactions = [];
  state.budgets = {};
  state.goals = [];
  state.nests = [];
  state.inbox = [];
  state.unread = 0;
  state.directory = [];
  state.adminNests = [];
  state.adminGoals = [];
  activeCozyNestId = null;
  state.inboxOpen = false;
  pendingNestMembers = [];

  const inboxModal = document.getElementById("inboxModal");
  if (inboxModal) inboxModal.classList.add("hidden");
  const msgModal = document.getElementById("adminMessageModal");
  if (msgModal) msgModal.classList.add("hidden");

  document.getElementById("profileModal").style.display = "none";
  document.querySelectorAll(".page-view").forEach((sec) => (sec.style.display = "none"));
  document.getElementById("mainNavbar").style.display = "none";
  document.getElementById("welcomeScreen").style.display = "flex";
  configureAuthUI();
  renderInboxBadge();
}

/* ---------------- profile ---------------- */

async function updateUserAvatar(newAvatarStr) {
  const user = getCurrentUser();
  if (!user) return;

  try {
    await api("/me/avatar", { method: "POST", body: { avatar: newAvatarStr } });
    state.user = { ...state.user, avatar: newAvatarStr };
    cacheAvatars();
    syncProfileAvatarUI(state.user);
    document.getElementById("avatarOptionsPopover").classList.add("hidden");
    document.getElementById("presetAvatarGrid").classList.add("hidden");
    showToast("🎨 Profile picture updated!");
    await syncAll({ quiet: true });
  } catch (err) {
    showToast("⚠️ " + err.message);
  }
}

async function handleChangePin(e) {
  e.preventDefault();
  const currentPin = document.getElementById("currentPinInput").value.trim();
  const newPin = document.getElementById("newPinInput").value.trim();
  if (!/^\d{4}$/.test(currentPin) || !/^\d{4}$/.test(newPin)) {
    return showToast("⚠️ Both passcodes must be exactly 4 digits.");
  }
  try {
    await api("/me/pin", { method: "POST", body: { currentPin, newPin } });
    document.getElementById("changePinForm").reset();
    showToast("🔐 Passcode changed!");
  } catch (err) {
    showToast("⚠️ " + err.message);
  }
}

async function resetCurrentUserData() {
  const user = getCurrentUser();
  if (!user) return;

  openCuteModal({
    icon: "🧹🐼",
    title: "Reset Personal Data?",
    message: "Clear all transactions, category budgets, and savings goals from every device? Your login profile will stay active.",
    confirmText: "Yes, Reset Data",
    cancelText: "Cancel",
    isDanger: true,
    onConfirm: async () => {
      try {
        await api("/me/reset", { method: "POST" });
        await syncAll({ quiet: true });
        showToast("🧹 Personal data reset!");
      } catch (err) {
        showToast("⚠️ " + err.message);
      }
    }
  });
}

function deleteMyOwnProfile() {
  const user = getCurrentUser();
  if (!user) return;

  if (isUserAdmin(user)) {
    openCuteModal({
      icon: "👑🔒",
      title: "Admin Profile Protected",
      message: "The permanent admin account can never be deleted. You can reset its personal data instead.",
      confirmText: "Got It",
      showCancel: false
    });
    return;
  }

  openCuteModal({
    icon: "🗑️🐼",
    title: "Delete Your Profile?",
    message: `Are you sure you want to permanently delete the profile ${user.email} and all personal data from the PennyNest server?`,
    confirmText: "Yes, Delete Profile",
    cancelText: "Keep My Nest",
    isDanger: true,
    onConfirm: async () => {
      try {
        await api("/me", { method: "DELETE" });
        showToast("🗑️ Your profile has been deleted.");
        lockApp(false);
      } catch (err) {
        showToast("⚠️ " + err.message);
      }
    }
  });
}

/* ---------------- theme & routing ---------------- */

async function setTheme(themeName, save = true) {
  document.body.classList.remove("theme-sakura", "theme-sky");
  if (themeName === "sakura") document.body.classList.add("theme-sakura");
  if (themeName === "sky") document.body.classList.add("theme-sky");

  localStorage.setItem(THEME_KEY, themeName);
  if (save) {
    showToast(`🎨 Theme switched to ${themeName.toUpperCase()}!`);
    if (state.user) {
      try {
        await api("/me/theme", { method: "POST", body: { theme: themeName }, quiet: true });
        state.user.theme = themeName;
      } catch (err) {
        /* theme still applies locally */
      }
    }
  }
}

function openPage(pageId) {
  const user = getCurrentUser();
  if (pageId === "adminCommandPage" && !isUserAdmin(user)) pageId = "dashboardPage";

  document.querySelectorAll(".page-view").forEach((sec) => (sec.style.display = "none"));
  document.querySelectorAll(".nav-links a").forEach((link) => link.classList.remove("active"));

  const target = document.getElementById(pageId);
  if (target) {
    target.style.display = "block";
    target.style.animation = "fadeIn 0.3s ease-out";
  }

  const navItem = document.getElementById("nav-" + pageId);
  if (navItem) navItem.classList.add("active");

  localStorage.setItem(PAGE_KEY, pageId);
  refreshAllViews();
}

/* ---------------- inbox ---------------- */

function renderInboxBadge() {
  const badge = document.getElementById("inboxUnreadBadge");
  if (!badge) return;
  if (state.unread > 0) {
    badge.textContent = state.unread > 9 ? "9+" : String(state.unread);
    badge.classList.remove("hidden");
  } else {
    badge.classList.add("hidden");
  }
}

async function openInbox() {
  const modal = document.getElementById("inboxModal");
  if (!modal) return;
  modal.classList.remove("hidden");
  state.inboxOpen = true;
  await loadInbox();
}

function closeInbox() {
  const modal = document.getElementById("inboxModal");
  if (modal) modal.classList.add("hidden");
  state.inboxOpen = false;
}

async function loadInbox() {
  const list = document.getElementById("inboxList");
  if (list) list.innerHTML = `<p class="empty-hint">Loading your messages…</p>`;
  try {
    const data = await api("/inbox");
    state.inbox = data.messages || [];
    state.unread = data.unread || 0;
    renderInboxBadge();
    renderInboxList();
  } catch (err) {
    if (list) list.innerHTML = `<p class="empty-hint error-text">${escapeHTML(err.message)}</p>`;
  }
}

function renderInboxList() {
  const list = document.getElementById("inboxList");
  if (!list) return;
  if (!state.inbox.length) {
    list.innerHTML = `<p class="empty-hint">No messages from the admin yet. 🌿</p>`;
    return;
  }
  list.innerHTML = state.inbox
    .map(
      (m) => `
      <article class="inbox-item ${m.read ? "" : "unread"}" onclick="markInboxMessageRead(${m.id})">
        <header class="inbox-item-head">
          <strong>👑 Message from PennyNest Admin</strong>
          <span class="badge ${m.read ? "" : "badge-alert"}">${m.read ? "Read" : "New"}</span>
        </header>
        <p class="inbox-body">${escapeHTML(m.body)}</p>
        <small class="inbox-time">${formatFullDate(m.createdAt)}</small>
      </article>
    `
    )
    .join("");
}

async function markInboxMessageRead(id) {
  const message = state.inbox.find((m) => m.id === id);
  if (!message || message.read) return;
  try {
    await api(`/inbox/${id}/read`, { method: "POST" });
    message.read = true;
    state.unread = state.inbox.filter((m) => !m.read).length;
    renderInboxBadge();
    renderInboxList();
  } catch (err) {
    showToast("⚠️ " + err.message);
  }
}

async function markAllInboxRead() {
  try {
    await api("/inbox/read-all", { method: "POST" });
    state.inbox.forEach((m) => (m.read = true));
    state.unread = 0;
    renderInboxBadge();
    renderInboxList();
  } catch (err) {
    showToast("⚠️ " + err.message);
  }
}

/* ---------------- admin: users table, downloads, messaging ---------------- */

function adminGuard() {
  return isUserAdmin(getCurrentUser());
}

function escapeAttr(str) {
  return escapeHTML(String(str)).replace(/'/g, "&#39;");
}

function adminUserRowActions(u) {
  return `
    <div class="admin-action-cell">
      <button type="button" class="icon-btn" title="Download this user's data as CSV" aria-label="Download CSVs" onclick="adminDownloadUserData(${u.id})">⬇️</button>
      <button type="button" class="icon-btn" title="Send a message to this user" aria-label="Message user" onclick="openAdminMessageModal(${u.id}, '${escapeAttr(u.email)}')">💬</button>
      <button type="button" class="icon-btn danger" title="Delete this user and all of their data" aria-label="Delete user" ${
        u.protected ? "disabled title=\"Permanent admin — cannot be deleted\"" : ""
      } onclick="adminDeleteUserAccount('${escapeAttr(u.email)}')">🗑️</button>
    </div>`;
}

async function adminDownloadUserData(userId) {
  if (!adminGuard()) return;
  try {
    showToast("⬇️ Preparing CSV download…");
    const res = await api(`/admin/users/${userId}/download.csv`, { raw: true });
    const blob = await res.blob();
    const disposition = res.headers.get("Content-Disposition") || "";
    const match = disposition.match(/filename="([^"]+)"/);
    const filename = match ? match[1] : `PennyNest_user_${userId}.csv`;
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.setAttribute("download", filename);
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    showToast("✅ CSV downloaded (no passcodes included).");
  } catch (err) {
    showToast("⚠️ " + err.message);
  }
}

function openAdminMessageModal(userId, email) {
  if (!adminGuard()) return;
  const modal = document.getElementById("adminMessageModal");
  if (!modal) return;
  document.getElementById("adminMessageUserId").value = String(userId);
  document.getElementById("adminMessageRecipient").textContent = email;
  document.getElementById("adminMessageBody").value = "";
  modal.classList.remove("hidden");
  document.getElementById("adminMessageBody").focus();
}

function closeAdminMessageModal() {
  const modal = document.getElementById("adminMessageModal");
  if (modal) modal.classList.add("hidden");
}

async function submitAdminMessage(e) {
  e.preventDefault();
  const userId = Number(document.getElementById("adminMessageUserId").value);
  const body = document.getElementById("adminMessageBody").value.trim();
  if (!body) return showToast("⚠️ Please type a message first.");

  const btn = document.getElementById("adminMessageSubmitBtn");
  if (btn) {
    btn.disabled = true;
    btn.textContent = "Sending…";
  }
  try {
    await api("/admin/messages", { method: "POST", body: { userId, body } });
    closeAdminMessageModal();
    showToast("💬 Message sent to the student's inbox!");
    await syncAll({ quiet: true });
  } catch (err) {
    showToast("⚠️ " + err.message);
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = "Send Message";
    }
  }
}

function adminDeleteUserAccount(targetEmail) {
  const currentAdmin = getCurrentUser();
  if (!isUserAdmin(currentAdmin)) return;

  const targetUser = getAllUsers().find((u) => u.email.toLowerCase() === targetEmail.toLowerCase());
  if (!targetUser) {
    showToast("⚠️ That user no longer exists. Refreshing…");
    return syncAll();
  }

  openCuteModal({
    icon: "👑🗑️",
    title: "Delete User Profile?",
    message: `Remove ${targetUser.email} and all of their data (transactions, budgets, goals, nests, messages) from PennyNest?`,
    confirmText: "Delete User",
    cancelText: "Cancel",
    isDanger: true,
    onConfirm: async () => {
      try {
        await api(`/admin/users/${targetUser.id}`, { method: "DELETE" });
        await syncAll({ quiet: true });
        showToast(`🗑️ Deleted profile for ${targetUser.email}.`);
      } catch (err) {
        showToast("⚠️ " + err.message);
      }
    }
  });
}

/* ---------------- admin: dashboard render ---------------- */

function renderAdminDashboard() {
  const user = getCurrentUser();
  if (!isUserAdmin(user)) return;

  const allUsers = state.directory;
  const allNests = state.adminNests;

  let totalTxCount = 0;
  let totalGoalsCount = 0;
  let completedGoalsCount = 0;
  let joinedThisMonth = 0;
  const currentMonthPrefix = new Date().toISOString().slice(0, 7);
  const categoryTxCounts = {
    Food: 0,
    Transport: 0,
    Education: 0,
    Utilities: 0,
    Entertainment: 0,
    Allowance: 0
  };

  allUsers.forEach((u) => {
    if (u.joined && String(u.joined).startsWith(currentMonthPrefix)) joinedThisMonth++;
    totalTxCount += Number(u.txCount) || 0;
    totalGoalsCount += Number(u.goalCount) || 0;
  });

  (state.adminGoals || []).forEach((g) => {
    if (Number(g.target) > 0 && Number(g.saved) >= Number(g.target)) completedGoalsCount++;
  });

  allNests.forEach((n) => {
    if (Number(n.saved) >= Number(n.target) && Number(n.target) > 0) completedGoalsCount++;
  });

  const setTxt = (id, val) => {
    const el = document.getElementById(id);
    if (el) el.textContent = Number(val).toLocaleString();
  };

  setTxt("admTileUsers", allUsers.length);
  setTxt("admTileNests", allNests.length);
  setTxt("admTileGoals", totalGoalsCount);
  setTxt("admTileCompletedGoals", completedGoalsCount);
  setTxt("admTileTxCount", totalTxCount);

  setTxt("admBoxTotalUsers", allUsers.length);
  setTxt("admBoxNewUsers", joinedThisMonth);
  setTxt("admBoxActiveNests", allNests.length);
  setTxt("admBoxTotalGoals", totalGoalsCount);
  setTxt("admBoxCompletedGoals", completedGoalsCount);
  setTxt("admBoxTotalLogs", totalTxCount);

  const searchQuery = ((document.getElementById("adminUserSearchInput") || {}).value || "").trim().toLowerCase();

  const buildUserRowsHTML = (list) => {
    if (!list.length) {
      return `<tr><td colspan="8" class="table-empty">No matching registered users found.</td></tr>`;
    }
    return list
      .map((u) => {
        const joinedDateStr = u.joined ? formatFullDate(u.joined) : "Recently";
        const lastLogin = u.lastLogin ? formatFullDate(u.lastLogin) : "never";
        return `
        <tr>
          <td><div class="table-avatar-mini">${renderAvatarVisual(u.avatar)}</div></td>
          <td>
            <div class="user-cell-email">${escapeHTML(u.email)}</div>
            <small class="user-cell-meta">Last login: ${lastLogin}</small>
          </td>
          <td><span class="badge">${u.role === "admin" ? "👑 Admin" : "🐼 Student"}</span></td>
          <td>${joinedDateStr}</td>
          <td class="num-font">${Number(u.txCount) || 0} logs</td>
          <td class="num-font">${Number(u.goalCount) || 0} goals</td>
          <td class="num-font">${Number(u.nestCount) || 0} nests</td>
          <td>${adminUserRowActions(u)}</td>
        </tr>`;
      })
      .join("");
  };

  const overviewBody = document.getElementById("adminOverviewUsersBody");
  if (overviewBody) overviewBody.innerHTML = buildUserRowsHTML(allUsers);

  const dirBody = document.getElementById("adminDirectoryUsersBody");
  if (dirBody) {
    const filtered = allUsers.filter((u) => u.email.toLowerCase().includes(searchQuery));
    dirBody.innerHTML = buildUserRowsHTML(filtered);
  }

  const nestsMonitorEl = document.getElementById("adminCozyNestsMonitorList");
  if (nestsMonitorEl) {
    if (!allNests.length) {
      nestsMonitorEl.innerHTML = `<p class="empty-hint">No Cozy Nests have been created on the platform yet.</p>`;
    } else {
      nestsMonitorEl.innerHTML = allNests
        .map((n) => {
          const pct = Number(n.target) > 0 ? Math.min(100, Math.round((Number(n.saved) / Number(n.target)) * 100)) : 0;
          const done = Number(n.saved) >= Number(n.target) && Number(n.target) > 0;
          return `
          <div class="goal-card">
            <div class="budget-top">
              <strong>🪺 ${escapeHTML(n.title)} ${done ? "🐷🎉" : ""}</strong>
              <span class="${done ? "badge-done" : "badge"}">${done ? "✔ Completed" : pct + "% Completed"}</span>
            </div>
            <div class="progress-track">
              <div class="progress-fill" style="width:${pct}%; background:linear-gradient(90deg, var(--primary), var(--accent-secondary));"></div>
            </div>
            <p class="treat-sub" style="margin-top:8px;">
              Members: <strong>${Number(n.memberCount)} student(s)</strong> • Chat Messages: <strong>${Number(n.messageCount)}</strong>
            </p>
          </div>`;
        })
        .join("");
    }
  }

  renderAdminDataTab(allUsers, allNests);

  const catBarsEl = document.getElementById("adminCategoryCountBars");
  if (catBarsEl) {
    // Counts come from the server-side admin goal/transaction aggregates.
    const counts = state.categoryCounts || categoryTxCounts;
    const maxCount = Math.max(1, ...Object.values(counts));
    catBarsEl.innerHTML = Object.entries(counts)
      .map(([cat, count]) => {
        const pct = Math.round((count / maxCount) * 100);
        return `
        <div class="budget-item">
          <div class="budget-top">
            <strong>${cat}</strong>
            <span class="num-font">${count} transactions logged</span>
          </div>
          <div class="progress-track">
            <div class="progress-fill" style="width:${pct}%; background:linear-gradient(90deg, var(--primary), var(--accent-secondary));"></div>
          </div>
        </div>`;
      })
      .join("");
  }

  const healthSync = document.getElementById("adminHealthSyncBadge");
  if (healthSync) healthSync.textContent = state.online ? "Connected ✓" : "Reconnecting…";
}

function renderAdminDataTab(allUsers, allNests) {
  const goalsBody = document.getElementById("adminDataGoalsBody");
  if (goalsBody) {
    const rows = (state.adminGoals || []).map((g) => {
      const target = Number(g.target);
      const saved = Number(g.saved);
      const pct = target > 0 ? Math.min(100, Math.round((saved / target) * 100)) : 0;
      const done = target > 0 && saved >= target;
      return `
        <tr>
          <td><div class="table-avatar-mini">${renderAvatarVisual(g.avatar)}</div></td>
          <td>${escapeHTML(g.email)}</td>
          <td>${escapeHTML(g.title)}</td>
          <td class="num-font">${saved.toLocaleString()} / ${target.toLocaleString()} BDT</td>
          <td style="min-width:120px;"><div class="progress-track"><div class="progress-fill ${done ? "done" : ""}" style="width:${pct}%; background:linear-gradient(90deg, var(--primary), var(--accent-secondary));"></div></div></td>
          <td><span class="${done ? "badge-done" : "badge"}">${done ? "✔ Completed" : pct + "%"}</span></td>
          <td>${done ? formatFullDate(g.completedAt) : "—"}</td>
        </tr>`;
    });
    goalsBody.innerHTML = rows.length
      ? rows.join("")
      : `<tr><td colspan="7" class="table-empty">No personal savings goals yet.</td></tr>`;
  }

  const nestsBody = document.getElementById("adminDataNestsBody");
  if (nestsBody) {
    nestsBody.innerHTML = allNests.length
      ? allNests
          .map((n) => {
            const target = Number(n.target);
            const saved = Number(n.saved);
            const pct = target > 0 ? Math.min(100, Math.round((saved / target) * 100)) : 0;
            const done = target > 0 && saved >= target;
            return `
        <tr>
          <td><strong>${escapeHTML(n.title)}</strong></td>
          <td class="num-font">${Number(n.memberCount)} mate(s)</td>
          <td class="num-font">${saved.toLocaleString()} / ${target.toLocaleString()} BDT</td>
          <td style="min-width:120px;"><div class="progress-track"><div class="progress-fill ${done ? "done" : ""}" style="width:${pct}%; background:linear-gradient(90deg, var(--primary), var(--accent-secondary));"></div></div></td>
          <td><span class="${done ? "badge-done" : "badge"}">${done ? "✔ Completed" : pct + "%"}</span></td>
          <td>${done ? formatFullDate(n.completedAt) : "—"}</td>
          <td class="num-font">${Number(n.contributionCount)}</td>
        </tr>`;
          })
          .join("")
      : `<tr><td colspan="7" class="table-empty">No Cozy Nests yet.</td></tr>`;
  }
}

/* ---------------- admin: global exports ---------------- */

async function downloadExport(path, fallbackName) {
  if (!adminGuard()) return;
  try {
    showToast("⬇️ Preparing download…");
    const res = await api(path, { raw: true });
    const blob = await res.blob();
    const disposition = res.headers.get("Content-Disposition") || "";
    const match = disposition.match(/filename="([^"]+)"/);
    const filename = match ? match[1] : fallbackName;
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.setAttribute("download", filename);
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    showToast("✅ Download ready!");
  } catch (err) {
    showToast("⚠️ " + err.message);
  }
}

function adminExportUsersCSV() {
  return downloadExport("/admin/export/csv/users", "PennyNest_Users.csv");
}
function adminExportTransactionsCSV() {
  return downloadExport("/admin/export/csv/transactions", "PennyNest_Transactions.csv");
}
function adminExportGoalsCSV() {
  return downloadExport("/admin/export/csv/goals", "PennyNest_Personal_Savings.csv");
}
function adminExportNestsCSV() {
  return downloadExport("/admin/export/csv/nests", "PennyNest_CozyNests_Savings.csv");
}
function adminExportContributionsCSV() {
  return downloadExport("/admin/export/csv/contributions", "PennyNest_Nest_Contributions.csv");
}
function adminExportEverythingJSON() {
  return downloadExport("/admin/export/all.json", "PennyNest_All_Data.json");
}

async function refreshAdminDashboard() {
  try {
    await syncAll({ quiet: true });
    showToast("🔄 Admin dashboard refreshed.");
  } catch (err) {
    showToast("⚠️ " + err.message);
  }
}

/* ---------------- boot ---------------- */

window.addEventListener("DOMContentLoaded", async () => {
  const todayStr = new Date().toISOString().split("T")[0];
  const txDateInput = document.getElementById("txDate");
  if (txDateInput) txDateInput.value = todayStr;

  const savedTheme = localStorage.getItem(THEME_KEY) || "matcha";
  setTheme(savedTheme, false);
  configureAuthUI();

  if (!state.token) return;

  setBusy(true, "Loading your nest…");
  try {
    await syncAll();
    if (state.user) {
      setTheme(state.user.theme || savedTheme, false);
      launchApp(false);
      startPolling();
    }
  } catch (err) {
    if (err.status !== 401) showStatusBanner("⚠️ " + err.message);
    lockApp(false);
  } finally {
    setBusy(false);
  }
});

/* ==================== 2. RENDER LAYER ==================== */
/* ============================================================
   PENNYNEST — UI / RENDER LAYER
   Pure view functions. All data comes from the in-memory cache in
   core.js (which is filled from the D1-backed API). No localStorage.
   ============================================================ */


/* ---- openCuteModal ---- */

function openCuteModal({
  icon = "🐼",
  title = "Are you sure?",
  message = "",
  confirmText = "Confirm",
  cancelText = "Cancel",
  showCancel = true,
  isDanger = false,
  onConfirm = null
}) {
  const modal = document.getElementById("customActionModal");
  document.getElementById("customModalIcon").textContent = icon;
  document.getElementById("customModalTitle").textContent = title;
  document.getElementById("customModalMessage").textContent = message;

  const cancelBtn = document.getElementById("customModalCancelBtn");
  const confirmBtn = document.getElementById("customModalConfirmBtn");

  cancelBtn.textContent = cancelText;
  cancelBtn.style.display = showCancel ? "inline-block" : "none";

  confirmBtn.textContent = confirmText;
  confirmBtn.className = isDanger ? "btn btn-danger" : "btn btn-primary";

  confirmBtn.onclick = () => {
    closeCustomModal();
    if (typeof onConfirm === "function") onConfirm();
  };

  modal.classList.remove("hidden");
}

/* ---- closeCustomModal ---- */

function closeCustomModal() {
  document.getElementById("customActionModal").classList.add("hidden");
}

// ==========================================
// 3. MULTI-PROFILE, AVATAR & EXCLUSIVE ADMIN SYSTEM
// ==========================================

/* ---- renderAvatarVisual ---- */

function renderAvatarVisual(avatarVal, extraClass = "") {
  if (avatarVal && avatarVal.startsWith("data:image")) {
    return `<img src="${avatarVal}" alt="Profile" class="${extraClass}">`;
  }
  return avatarVal || "🐼";
}

/* ---- switchAuthMode ---- */

function switchAuthMode(mode) {
  const loginForm = document.getElementById("loginForm");
  const registerForm = document.getElementById("registerForm");
  const tabLogin = document.getElementById("tabLoginMode");
  const tabReg = document.getElementById("tabRegisterMode");

  if (mode === "login") {
    loginForm.classList.remove("hidden");
    registerForm.classList.add("hidden");
    tabLogin.classList.add("active");
    tabReg.classList.remove("active");
  } else {
    loginForm.classList.add("hidden");
    registerForm.classList.remove("hidden");
    tabLogin.classList.remove("active");
    tabReg.classList.add("active");
  }
}

/* ---- handleLogoClick ---- */

function handleLogoClick() {
  const user = getCurrentUser();
  if (isUserAdmin(user)) {
    openPage("adminCommandPage");
  } else {
    openPage("dashboardPage");
  }
}

/* ---- syncProfileAvatarUI ---- */

function syncProfileAvatarUI(user) {

  document.getElementById("modalEmail").textContent = user.email;
  document.getElementById("modalRoleBadge").textContent =
    isUserAdmin(user) ? "👑 Admin (Site Owner)" : "🐼 Student User";

  const avatarHTML = renderAvatarVisual(user.avatar);
  document.getElementById("pandaAvatar").innerHTML = avatarHTML;
  document.getElementById("topProfileBtn").innerHTML = avatarHTML;
}

// Clicking the Profile Circle in the Modal Toggles the 2 Options (Choose Avatar / Personal Photo)

/* ---- toggleAvatarOptionsMenu ---- */

function toggleAvatarOptionsMenu(event) {
  triggerPandaJoy(event);
  const pop = document.getElementById("avatarOptionsPopover");
  const grid = document.getElementById("presetAvatarGrid");
  if (pop.classList.contains("hidden")) {
    pop.classList.remove("hidden");
    grid.classList.add("hidden");
  } else {
    pop.classList.add("hidden");
    grid.classList.add("hidden");
  }
}

/* ---- showPresetAvatarGrid ---- */

function showPresetAvatarGrid() {
  const grid = document.getElementById("presetAvatarGrid");
  grid.classList.toggle("hidden");
}

/* ---- handlePersonalPhotoUpload ---- */

function handlePersonalPhotoUpload(event) {
  const file = event.target.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = function (e) {
    updateUserAvatar(e.target.result);
  };
  reader.readAsDataURL(file);
}

// ==========================================
// 4. EXCLUSIVE ADMIN COMMAND CENTER (PRIVACY-SAFE SUMMARY)
// ==========================================

/* ---- switchAdminSubTab ---- */

function switchAdminSubTab(tabName) {
  currentAdminSubTab = tabName;

  const tabs = ["overview", "directory", "nests", "analysis", "data", "health"];
  tabs.forEach(t => {
    const viewEl = document.getElementById(`adminSubView-${t}`);
    const btnEl = document.getElementById(`admTabBtn-${t}`);
    if (viewEl) {
      if (t === tabName) viewEl.classList.remove("hidden");
      else viewEl.classList.add("hidden");
    }
    if (btnEl) {
      if (t === tabName) btnEl.classList.add("active");
      else btnEl.classList.remove("active");
    }
  });

  const titles = {
    overview: ["Admin Command Dashboard", "Pastel Matrix overview of community growth, activity trends, and privacy-safe user summaries."],
    directory: ["Registered User Directory", "Search registered profiles and manage accounts without exposing private balances or passcodes."],
    nests: ["Cozy Nests Monitor", "Overview of collaborative student groups and milestone completion across PennyNest."],
    analysis: ["Site Analysis & Category Activity", "Platform-wide transaction counts by category (private BDT amounts remain hidden)."],
    data: ["Data & Downloads", "Review and download users, transactions, personal savings and Cozy Nest savings (passcodes are never included)."],
    health: ["Platform Health & Privacy Shield", "Diagnostics for local storage modules and user privacy safeguards."]
  };

  const titlePair = titles[tabName] || titles.overview;
  document.getElementById("adminSubPageTitle").textContent = titlePair[0];
  document.getElementById("adminSubPageSubtitle").textContent = titlePair[1];

  renderAdminDashboard();
}

/* ---- toggleProfileModal ---- */

function toggleProfileModal() {
  const modal = document.getElementById("profileModal");
  const isOpening = modal.style.display !== "flex";
  modal.style.display = isOpening ? "flex" : "none";

  document.getElementById("avatarOptionsPopover").classList.add("hidden");
  document.getElementById("presetAvatarGrid").classList.add("hidden");

  if (isOpening) {
    rotatePandaMood();
  }
}

/* ---- rotatePandaMood ---- */

function rotatePandaMood() {
  const moodEl = document.getElementById("pandaMoodText");
  if (!moodEl) return;
  moodEl.textContent = pandaMoods[currentMoodIndex];
  currentMoodIndex = (currentMoodIndex + 1) % pandaMoods.length;
}

/* ---- triggerPandaJoy ---- */

function triggerPandaJoy(event) {
  const avatar = document.getElementById("pandaAvatar");
  avatar.classList.remove("panda-bounce");
  void avatar.offsetWidth;
  avatar.classList.add("panda-bounce");

  rotatePandaMood();

  const emojis = ["🤎", "🎋", "🌿", "💚", "🐼"];
  const rect = avatar.getBoundingClientRect();
  const centerX = rect.left + rect.width / 2;
  const centerY = rect.top + rect.height / 2;

  for (let i = 0; i < 6; i++) {
    const span = document.createElement("span");
    span.className = "panda-float-emoji";
    span.textContent = emojis[Math.floor(Math.random() * emojis.length)];
    span.style.left = centerX + (Math.random() * 70 - 35) + "px";
    span.style.top = centerY + (Math.random() * 30 - 15) + "px";
    document.body.appendChild(span);
    setTimeout(() => span.remove(), 1400);
  }
}

// ==========================================
// 5. THEME & PAGE ROUTING
// ==========================================

/* ---- formatReadableDate ---- */

function formatReadableDate(isoDateStr) {
  if (!isoDateStr) return "";
  const months = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December"
  ];
  const parts = isoDateStr.split("-");
  if (parts.length !== 3) return isoDateStr;
  const day = parseInt(parts[2], 10);
  const monthIdx = parseInt(parts[1], 10) - 1;
  if (isNaN(day) || monthIdx < 0 || monthIdx > 11) return isoDateStr;
  return `${day} ${months[monthIdx]}`;
}

/* ---- getLedgerTransactionsWithDynamicSampleMonth ---- */

function getLedgerTransactionsWithDynamicSampleMonth(monthFilter) {
  const rawList = getTransactions();
  if (!monthFilter) return rawList;

  // Calculate max days in the chosen YYYY-MM so days like 31 don't overflow in Feb/Apr
  const [yrStr, moStr] = monthFilter.split("-");
  const yr = parseInt(yrStr, 10);
  const mo = parseInt(moStr, 10);
  const maxDaysInMonth = (!isNaN(yr) && !isNaN(mo)) ? new Date(yr, mo, 0).getDate() : 28;

  return rawList.map(tx => {
    if (tx.isSample) {
      const origDay = parseInt(tx.sampleDay || (tx.date ? tx.date.split("-")[2] : "10"), 10) || 10;
      const safeDay = String(Math.min(origDay, maxDaysInMonth)).padStart(2, "0");
      return {
        ...tx,
        date: `${monthFilter}-${safeDay}`
      };
    }
    return tx;
  });
}

// Download CSV based on whichever Transaction Type and Month are selected

/* ---- downloadTransactionsByType ---- */

function downloadTransactionsByType() {
  const typeFilter = document.getElementById("filterType").value;
  const catFilter = document.getElementById("filterCategory").value;
  const monthFilter = document.getElementById("filterMonth").value;
  const query = (document.getElementById("searchInput").value || "").toLowerCase();

  const sourceList = getLedgerTransactionsWithDynamicSampleMonth(monthFilter);

  const filteredList = sourceList.filter(tx => {
    const matchesText = tx.title.toLowerCase().includes(query);
    const matchesCat = catFilter === "All" || tx.category === catFilter;
    const matchesMonth = !monthFilter || (tx.date && tx.date.startsWith(monthFilter));
    const matchesType = typeFilter === "All" || tx.type === typeFilter;
    return matchesText && matchesCat && matchesMonth && matchesType;
  });

  const typeLabel =
    typeFilter === "income"
      ? "Income"
      : typeFilter === "expense"
      ? "Expense"
      : "All_Types";

  if (filteredList.length === 0) {
    openCuteModal({
      icon: "📭",
      title: "No Records Found",
      message: `There are no ${typeLabel.replace("_", " ")} transactions matching your filter to download!`,
      confirmText: "Got It",
      showCancel: false
    });
    return;
  }

  let totalIncome = 0;
  let totalExpense = 0;

  const csvRows = [
    ["Date", "Description", "Category", "Type", "Amount (BDT)"]
  ];

  filteredList.forEach(tx => {
    const cleanTitle = `"${String(tx.title).replace(/"/g, '""')}"`;
    const signedAmount = tx.type === "income" ? `+${tx.amount}` : `${tx.amount}`;
    csvRows.push([
      formatReadableDate(tx.date),
      cleanTitle,
      tx.category,
      tx.type.toUpperCase(),
      signedAmount
    ]);

    if (tx.type === "income") totalIncome += Number(tx.amount);
    else totalExpense += Number(tx.amount);
  });

  csvRows.push([]);
  if (typeFilter === "All" || typeFilter === "income") {
    csvRows.push(["SUMMARY", "", "", "Total Income", `${totalIncome} BDT`]);
  }
  if (typeFilter === "All" || typeFilter === "expense") {
    csvRows.push(["SUMMARY", "", "", "Total Expense", `${totalExpense} BDT`]);
  }
  if (typeFilter === "All") {
    csvRows.push(["SUMMARY", "", "", "Net Balance", `${totalIncome - totalExpense} BDT`]);
  }

  const csvContent = csvRows.map(r => r.join(",")).join("\n");
  const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);

  const link = document.createElement("a");
  link.href = url;
  link.setAttribute("download", `PennyNest_${typeLabel}_Statement.csv`);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);

  showToast(`📥 Downloaded ${typeLabel.replace("_", " ")} statement!`);
}

// ==========================================
// 8. CUTE MODAL CONFIRMATIONS FOR ALL RESET/DELETE BUTTONS
// ==========================================

/* ---- checkTreatAffordability ---- */

function checkTreatAffordability() {
  const price = parseFloat(document.getElementById("treatPriceInput").value);
  const resultEl = document.getElementById("treatResultMsg");
  if (isNaN(price) || price <= 0) {
    resultEl.textContent = "Please type a valid price first!";
    resultEl.style.color = "var(--red)";
    return;
  }

  const list = getTransactions();
  let income = 0, expense = 0;
  list.forEach(tx => {
    if (tx.type === "income") income += Number(tx.amount);
    else expense += Number(tx.amount);
  });
  const balance = income - expense;
  const safeDaily = Math.max(0, Math.round(balance / 15));

  if (price <= safeDaily * 0.6) {
    resultEl.textContent = "🍵 Go for it! Totally safe for today's daily allowance.";
    resultEl.style.color = "var(--green)";
  } else if (price <= safeDaily) {
    resultEl.textContent = "⚠️ You can afford it, but it uses most of today's safe spend!";
    resultEl.style.color = "#d97706";
  } else {
    resultEl.textContent = `🚨 Hold on! That costs more than your safe daily limit (${safeDaily} BDT)!`;
    resultEl.style.color = "var(--red)";
  }
}

// ==========================================
// 10. PAGE 5: COZY NESTS (SEARCH BY NAME/ID, JOINT SAVINGS & CHAT)
// ==========================================

/* ---- addMemberToPendingNest ---- */

function addMemberToPendingNest(email) {
  const cleanEmail = email.toLowerCase();
  if (!pendingNestMembers.includes(cleanEmail)) {
    pendingNestMembers.push(cleanEmail);
  }
  document.getElementById("memberSearchInput").value = "";
  document.getElementById("userSearchResults").innerHTML = "";
  renderPendingNestMembersChips();
}

/* ---- removeMemberFromPendingNest ---- */

function removeMemberFromPendingNest(email) {
  const user = getCurrentUser();
  if (user && email.toLowerCase() === user.email.toLowerCase()) return;
  pendingNestMembers = pendingNestMembers.filter(m => m !== email.toLowerCase());
  renderPendingNestMembersChips();
}

/* ---- renderPendingNestMembersChips ---- */

function renderPendingNestMembersChips() {
  const user = getCurrentUser();
  if (!user) return;
  if (!pendingNestMembers.includes(user.email.toLowerCase())) {
    pendingNestMembers.unshift(user.email.toLowerCase());
  }

  const allUsers = getAllUsers();
  const container = document.getElementById("selectedNestMembers");
  if (!container) return;

  container.innerHTML = pendingNestMembers
    .map(email => {
      const found = allUsers.find(u => u.email.toLowerCase() === email.toLowerCase());

      const isCreator = email.toLowerCase() === user.email.toLowerCase();
      return `
      <span class="member-pill">
        <span class="members-avatar-line">${avatarChipByEmail(email)} <span>${escapeHTML(email)}</span></span>
        ${
          isCreator
            ? `<small>(You)</small>`
            : `<button type="button" onclick="removeMemberFromPendingNest('${escapeHTML(email)}')">✕</button>`
        }
      </span>
    `;
    })
    .join("");
}

/* ---- renderCozyNestsPage ---- */

function renderCozyNestsPage() {
  const user = getCurrentUser();
  if (!user) return;

  renderPendingNestMembersChips();

  const allUsers = getAllUsers();
  const allMine = getAllCozyNests().filter(n =>
    n.members.some(m => m.toLowerCase() === user.email.toLowerCase())
  );
  const myNests = allMine.filter(n => !isGoalDone(n));
  const doneNests = allMine.filter(n => isGoalDone(n));

  const listEl = document.getElementById("myCozyNestsList");
  if (!listEl) return;

  const doneEl = document.getElementById("completedCozyNestsList");
  if (doneEl) {
    doneEl.innerHTML = doneNests.length === 0
      ? `<p class="completed-history-empty">No completed Cozy Nests yet. Reach a joint goal and it will be saved here for future review.</p>`
      : doneNests.map(n => {
          const isSelected = n.id === activeCozyNestId;
          return `
        <div class="goal-card completed-card" style="cursor:pointer; ${isSelected ? "border-color:#2563eb !important;" : ""}" onclick="selectCozyNest(${n.id})">
          <div class="budget-top">
            <strong>🪺 ${escapeHTML(n.title)} 💙</strong>
            <span class="badge-done">✔ Completed</span>
          </div>
          <div class="progress-track"><div class="progress-fill done" style="width:100%;"></div></div>
          <p class="treat-sub" style="margin-top:8px;">
            Saved: <strong>${Number(n.saved).toLocaleString()} / ${Number(n.target).toLocaleString()} BDT</strong> • ${n.members.length} Nest Mate(s)<br>
            Completed on: <strong>${formatFullDate(n.completedAt)}</strong>
          </p>
        </div>`;
        }).join("");
  }

  if (myNests.length === 0) {
    listEl.innerHTML = `<p style="color:var(--text-muted);">You aren't in any Cozy Nests yet. Create one above and search friends by Name or Email/ID!</p>`;
  } else {
    listEl.innerHTML = myNests
      .map(n => {
        const pct = Math.min(100, Math.round((n.saved / n.target) * 100));
        const isSelected = n.id === activeCozyNestId;
        return `
        <div class="goal-card" style="cursor:pointer; border-color:${isSelected ? "var(--primary)" : "var(--border)"};" onclick="selectCozyNest(${n.id})">
          <div class="budget-top">
            <strong>🪺 ${escapeHTML(n.title)}</strong>
            <span class="badge">${pct}%</span>
          </div>
          <div class="progress-track">
            <div class="progress-fill" style="width:${pct}%; background:linear-gradient(90deg, var(--primary), var(--accent-secondary));"></div>
          </div>
          <p class="treat-sub" style="margin-top:8px;">
            Saved: <strong>${n.saved.toLocaleString()} / ${n.target.toLocaleString()} BDT</strong> • ${n.members.length} Nest Mate(s)
          </p>
        </div>
      `;
      })
      .join("");
  }

  renderActiveCozyNestDetail(allUsers);
}

/* ---- selectCozyNest ---- */

function selectCozyNest(nestId) {
  activeCozyNestId = nestId;
  renderCozyNestsPage();
}

/* ---- renderActiveCozyNestDetail ---- */

function renderActiveCozyNestDetail(allUsers) {
  const noView = document.getElementById("noNestSelectedView");
  const detailView = document.getElementById("activeNestDetailView");
  if (!noView || !detailView) return;

  const nest = getAllCozyNests().find(n => n.id === activeCozyNestId);
  if (!nest) {
    noView.classList.remove("hidden");
    detailView.classList.add("hidden");
    return;
  }

  noView.classList.add("hidden");
  detailView.classList.remove("hidden");

  const pct = Math.min(100, Math.round((nest.saved / nest.target) * 100));
  document.getElementById("activeNestName").textContent = `🪺 ${nest.title}`;
  const done = isGoalDone(nest);
  const badgeEl = document.getElementById("activeNestPctBadge");
  badgeEl.textContent = done ? "✔ Completed" : `${pct}%`;
  badgeEl.className = done ? "badge-done" : "welcome-badge";
  document.getElementById("activeNestAmountText").textContent = `${Number(nest.saved).toLocaleString()} / ${Number(nest.target).toLocaleString()} BDT`;
  const barEl = document.getElementById("activeNestProgressBar");
  barEl.style.width = `${pct}%`;
  barEl.classList.toggle("done", done);

  // Members shown as profile pictures only (no names)
  document.getElementById("activeNestMembersLine").innerHTML =
    `<span class="members-avatar-line">Nest Mates: ${nest.members.map(email => avatarChipByEmail(email)).join("")}</span>`;

  // Completed banner + locked contribution/invite when the goal is done
  const banner = document.getElementById("activeNestDoneBanner");
  banner.classList.toggle("hidden", !done);
  if (done) {
    banner.innerHTML = `💙 Goal completed and saved to your history on <strong>${formatFullDate(nest.completedAt)}</strong>. You can review it any time.`;
  }
  document.getElementById("nestContributeForm").classList.toggle("hidden", done);
  document.getElementById("nestInviteBox").classList.toggle("hidden", done);

  // Who contributed how much (avatar only)
  const summaryEl = document.getElementById("nestContribSummary");
  const contribs = nest.contributions || [];
  if (contribs.length === 0) {
    summaryEl.classList.add("hidden");
  } else {
    const totals = {};
    contribs.forEach(c => { totals[c.email.toLowerCase()] = (totals[c.email.toLowerCase()] || 0) + Number(c.amount); });
    summaryEl.classList.remove("hidden");
    summaryEl.innerHTML = `<h4>💙 Contributions</h4>` + Object.entries(totals).map(([email, amt]) =>
      `<div class="contrib-row"><span class="who">${avatarChipByEmail(email)}<span class="em">${escapeHTML(email)}</span></span><strong class="num-font">${amt.toLocaleString()} BDT</strong></div>`
    ).join("");
  }


  const user = getCurrentUser();
  const chatBox = document.getElementById("nestChatMessages");
  chatBox.innerHTML = nest.messages
    .map(m => {
      const isMe = user && m.senderEmail.toLowerCase() === user.email.toLowerCase();
      return `
      <div class="ai-msg ${isMe ? "user" : "bot"}">
        <span class="chat-sender">${m.senderEmail === "system" ? "🐷" : avatarChipByEmail(m.senderEmail)}</span> ${escapeHTML(m.text)}
      </div>
    `;
    })
    .join("");
  chatBox.scrollTop = chatBox.scrollHeight;
}

/* ---- initAiChatGreeting ---- */

function initAiChatGreeting() {
  const box = document.getElementById("aiChatMessages");
  const user = getCurrentUser();
  if (!box) return;
  box.innerHTML = `
    <div class="ai-msg bot">
      <strong>Penny AI 🐼:</strong> Hi there! Type <strong>"guide me"</strong> for a full tour of PennyAI & PennyNest, say hi, or ask me about your allowance, daily spend, treats, hostel/mess budget, savings goals, or Cozy Nests! 🌿
    </div>
  `;
}

/* ---- sendPresetAiPrompt ---- */

function sendPresetAiPrompt(text) {
  appendAiChatBubble(text, "user");
  const reply = generatePennyAiReply(text);
  setTimeout(() => appendAiChatBubble(reply, "bot"), 180);
}

/* ---- handleAiChatSubmit ---- */

function handleAiChatSubmit(e) {
  e.preventDefault();
  const input = document.getElementById("aiChatInput");
  const query = input.value.trim();
  if (!query) return;

  appendAiChatBubble(query, "user");
  input.value = "";
  const reply = generatePennyAiReply(query);
  setTimeout(() => appendAiChatBubble(reply, "bot"), 180);
}

/* ---- appendAiChatBubble ---- */

function appendAiChatBubble(text, senderType) {
  const box = document.getElementById("aiChatMessages");
  if (!box) return;
  const div = document.createElement("div");
  div.className = `ai-msg ${senderType}`;
  div.innerHTML = senderType === "bot" ? `<strong>Penny AI 🐼:</strong> ${text}` : escapeHTML(text);
  box.appendChild(div);
  box.scrollTop = box.scrollHeight;
}

/* ---- generatePennyAiReply ---- */

function generatePennyAiReply(rawInput) {
  const q = rawInput.toLowerCase().trim();
  const user = getCurrentUser();
  const firstName = "friend";

  const txs = getTransactions();
  const budgets = getBudgets();
  const goals = getGoals();
  const myNests = getAllCozyNests().filter(
    n => user && n.members.includes(user.email.toLowerCase())
  );

  let income = 0, expense = 0;
  const catTotals = {};
  txs.forEach(tx => {
    if (tx.type === "income") {
      income += Number(tx.amount);
    } else {
      expense += Number(tx.amount);
      catTotals[tx.category] = (catTotals[tx.category] || 0) + Number(tx.amount);
    }
  });

  const balance = income - expense;
  const safeDaily = Math.max(0, Math.round(balance / 15));
  const safeWeekly = safeDaily * 7;

  // 1. GUIDE ABOUT PENNYAI & PENNYNEST
  if (
    q.includes("guide") ||
    q.includes("pennyai") ||
    q.includes("penny ai") ||
    q.includes("pennynest") ||
    q.includes("penny nest") ||
    q.includes("how to use") ||
    q.includes("how do i use") ||
    q.includes("tutorial") ||
    q.includes("walkthrough") ||
    q.includes("what can you do") ||
    q.includes("what can i ask") ||
    q.includes("features") ||
    q.includes("help") ||
    q.includes("explain the app")
  ) {
    return `Here is your complete guide to <strong>Penny AI & PennyNest</strong> 🧭🐼:<br>
    • <strong>Dashboard:</strong> Log quick income/expenses, check your Safe Daily Spend (${safeDaily} BDT/day), test snacks in the Guilt-Free Treat Checker, or load sample student data!<br>
    • <strong>Transactions:</strong> Filter by any month in the calendar, category, or type, and download CSV statements with dates formatted like <em>10 November</em>.<br>
    • <strong>Budgets:</strong> Set monthly category caps and watch live Panda mood reactions.<br>
    • <strong>Savings Goals:</strong> Deposit any custom BDT amount to unlock the bouncing <strong>Happy Piggy + Confetti</strong> at 100%!<br>
    • <strong>Cozy Nests:</strong> Search friends by Name or Email/ID to save together & chat!<br>
    • <strong>Ask Me Anything On-Topic:</strong> Try asking about your balance, daily spend, category totals, hostel/mess tips, bKash/Nagad tracking, textbook savings, or the 50/30/20 rule!`;
  }

  // 2. GREETINGS, IDENTITY & SMALL TALK
  if (/^(hi|hello|hey|hiya|yo|assalamu|salam|namaste|good morning|good afternoon|good evening|morning|evening|sup|hola)\b/.test(q)) {
    return `Hello ${escapeHTML(firstName)}! 🐼🌿 Welcome to your cozy financial nest! Your available balance is <strong>${balance.toLocaleString()} BDT</strong> and your safe daily allowance is <strong>${safeDaily.toLocaleString()} BDT/day</strong>. Ask me anything about PennyNest or your student budget!`;
  }
  if (q.includes("who are you") || q.includes("your name") || q.includes("what are you")) {
    return `I'm <strong>Penny AI 🐼</strong>, your mindful student finance assistant inside PennyNest! I help you track allowances, test impulse treats, monitor category budgets, and celebrate savings goals.`;
  }
  if (q.includes("how are you") || q.includes("how r u") || q.includes("how's it going") || q.includes("what's up")) {
    return `I'm munching fresh bamboo and guarding your pennies! 🎋 You currently have <strong>${balance.toLocaleString()} BDT</strong> in your nest. How are you feeling about your budget today?`;
  }
  if (q.includes("thank") || q.includes("thx") || q.includes("tysm") || q.includes("awesome") || q.includes("smart") || q.includes("cute") || q.includes("love you")) {
    return `Aww, thank you ${escapeHTML(firstName)}! 🤎🐼🐷 Penny Piggy and I are always cheering for your financial goals!`;
  }
  if (q.includes("bye") || q.includes("goodbye") || q.includes("good night") || q.includes("see you") || q.includes("cya")) {
    return `Bye-bye ${escapeHTML(firstName)}! 🏡 Tap the round avatar icon on the top-right if you want to lock your nest before leaving! 💚`;
  }

  // 3. PROFILE PICTURE, PASSCODE, RESET, DELETE PROFILE & THEME QUESTIONS
  if (q.includes("avatar") || q.includes("profile picture") || q.includes("photo") || q.includes("dp") || q.includes("icon")) {
    return `Click the <strong>round profile icon at the top-right</strong>, then tap your <strong>profile circle</strong> inside the modal! Two options will pop up: <em>Choose Avatar</em> or <em>Personal Photo</em>! 📷🐼`;
  }
  if (q.includes("delete profile") || q.includes("remove account") || q.includes("delete account") || q.includes("reset")) {
    return `Open your profile modal from the top-right round icon and click <strong>"🧹 Reset My Personal Data"</strong> or <strong>"🗑️ Delete My Profile"</strong>—every reset or delete action uses a cozy confirmation modal!`;
  }
  if (q.includes("pin") || q.includes("passcode") || q.includes("password") || q.includes("lock") || q.includes("switch account") || q.includes("logout")) {
    return `Your nest is protected by a 4-digit passcode! 🔐 To lock your nest or switch accounts, click the round profile icon on the top-right and select <strong>"Switch Account / Lock Nest"</strong>.`;
  }
  if (q.includes("theme") || q.includes("color") || q.includes("matcha") || q.includes("sakura") || q.includes("sky") || q.includes("dots") || q.includes("vibe")) {
    return `Click any of the <strong>3 pastel dots</strong> in the top navbar (Matcha Mint 🍵, Sakura Pink 🌸, or Cotton Candy Sky ☁️) right beside your round profile icon!`;
  }

  // 4. SAMPLE DATA, CSV DOWNLOAD & DATE FORMAT QUESTIONS
  if (q.includes("sample") || q.includes("demo") || q.includes("full year") || q.includes("12 month") || q.includes("each month")) {
    return `Click the <strong>"📥 Load Sample Data"</strong> button at the top of the Dashboard! Whenever you switch months in the Transaction Ledger calendar, those sample entries automatically appear for the selected month! 📅`;
  }
  if (q.includes("download") || q.includes("csv") || q.includes("export") || q.includes("statement") || q.includes("date")) {
    return `Go to the <strong>Transactions</strong> page and select <em>All Types</em>, <em>Income (+)</em>, or <em>Expense (-)</em> in the dropdown—then click the Download CSV button to export that exact type! Dates are displayed cleanly like <strong>10 November</strong>. 📥`;
  }

  // 5. SPECIFIC CATEGORY SPENDING QUERIES
  const categoryMap = {
    Food: ["food", "snack", "lunch", "dinner", "breakfast", "canteen", "restaurant", "meal", "burger", "pizza", "biryani"],
    Transport: ["transport", "fare", "rickshaw", "bus", "uber", "cng", "commute", "travel", "ticket"],
    Education: ["education", "book", "study", "tuition", "stationery", "photocopy", "lab", "pen", "notebook", "course", "exam", "semester", "pdf"],
    Utilities: ["utilities", "utility", "mobile", "internet", "wifi", "data", "recharge", "phone", "bill", "electricity"],
    Entertainment: ["entertainment", "outing", "movie", "game", "fun", "hangout", "concert", "party", "netflix"]
  };

  for (const [catName, keywords] of Object.entries(categoryMap)) {
    if (keywords.some(kw => q.includes(kw)) && (q.includes("spend") || q.includes("spent") || q.includes("how much") || q.includes("budget") || q.includes("limit") || q.includes("cost") || q.includes("save"))) {
      const spent = catTotals[catName] || 0;
      const limit = budgets[catName];
      if (limit) {
        const left = Math.max(0, limit - spent);
        const pct = Math.round((spent / limit) * 100);
        return `In <strong>${catName}</strong>, you have spent <strong>${spent.toLocaleString()} BDT</strong> out of your ${limit.toLocaleString()} BDT monthly limit (${pct}%). You have <strong>${left.toLocaleString()} BDT</strong> remaining! 📊`;
      }
      return `You have spent <strong>${spent.toLocaleString()} BDT</strong> on <strong>${catName}</strong> so far. You can set a monthly cap for ${catName} on the Budgets page! ⚙️`;
    }
  }

  // 6. CAMPUS LIFE SPECIFIC TOPICS (Hostel/Mess, bKash/Nagad, Scholarships, Textbooks, Group Trips)
  if (q.includes("hostel") || q.includes("mess") || q.includes("dorm") || q.includes("roommate") || q.includes("hall")) {
    return `🏡 <strong>Hostel & Mess Budget Tip:</strong> Pay your fixed mess/meal charge at the start of the month and log it under <em>Food</em>, or create a shared <strong>Cozy Nest</strong> with your roommates to track shared room utilities and groceries together!`;
  }
  if (q.includes("bkash") || q.includes("nagad") || q.includes("rocket") || q.includes("mobile banking") || q.includes("cashout") || q.includes("wallet")) {
    return `📱 <strong>Mobile Wallet Tip:</strong> Cash-out fees on bKash/Nagad add up fast over a semester! Try withdrawing once a week or paying campus merchants via direct QR scan, and log any transfer fee under <em>Utilities</em>.`;
  }
  if (q.includes("scholarship") || q.includes("stipend") || q.includes("tuition") || q.includes("part time") || q.includes("tutoring") || q.includes("freelanc")) {
    return `🎓 <strong>Student Income Tip:</strong> Whenever you receive tutoring pay, freelancing income, or a scholarship stipend, log it as <strong>Income (+)</strong> under <em>Allowance</em> and immediately move 20% into a <strong>Savings Goal</strong>!`;
  }
  if (q.includes("textbook") || q.includes("photocopy") || q.includes("library") || q.includes("print")) {
    return `📚 <strong>Study Savings Tip:</strong> Borrow core textbooks from seniors or the university library, share PDFs for reference chapters, and pool printing orders with classmates to lower per-page costs!`;
  }

  // 7. TREAT, COFFEE, BOBA, SNACKS & NUMBER AFFORDABILITY CHECKS
  if (
    q.includes("treat") ||
    q.includes("coffee") ||
    q.includes("boba") ||
    q.includes("tea") ||
    q.includes("momo") ||
    q.includes("fuchka") ||
    q.includes("ice cream") ||
    q.includes("chocolate") ||
    q.includes("bangle") ||
    q.includes("kakon") ||
    q.includes("shopping") ||
    q.includes("dress") ||
    q.includes("afford") ||
    q.includes("can i buy") ||
    q.includes("can i spend") ||
    q.includes("should i buy") ||
    q.includes("worth it")
  ) {
    const numMatch = q.match(/\d+/);
    if (numMatch) {
      const price = Number(numMatch[0]);
      if (price <= safeDaily * 0.6) {
        return `Green light! 🍵 <strong>${price.toLocaleString()} BDT</strong> is well within your safe daily spend of ${safeDaily.toLocaleString()} BDT/day. Treat yourself guilt-free! 💚`;
      } else if (price <= safeDaily) {
        return `Mindful caution! ⚠️ <strong>${price.toLocaleString()} BDT</strong> fits inside today's ${safeDaily.toLocaleString()} BDT safe allowance, but it uses most of your daily cushion.`;
      } else if (price <= balance) {
        return `Hold on panda! 🚨 <strong>${price.toLocaleString()} BDT</strong> exceeds your safe daily limit (${safeDaily.toLocaleString()} BDT/day). If it's a big wish, add it to your <strong>Savings Goals</strong> tab instead!`;
      } else {
        return `Stop right there! 🛡️ <strong>${price.toLocaleString()} BDT</strong> is more than your entire available balance (${balance.toLocaleString()} BDT)!`;
      }
    }
    return `Your safe daily spend is <strong>${safeDaily.toLocaleString()} BDT/day</strong>, so any small treat under <strong>${Math.round(safeDaily * 0.6)} BDT</strong> is completely guilt-free! Ask me with a number like <em>"Can I spend 180 on coffee?"</em>! 🧋`;
  }

  // 8. SAFE DAILY, WEEKLY & SURVIVAL PACING
  if (q.includes("daily") || q.includes("today") || q.includes("per day") || q.includes("weekly") || q.includes("week") || q.includes("last") || q.includes("survive")) {
    return `With <strong>${balance.toLocaleString()} BDT</strong> available, your safe daily spend is <strong>${safeDaily.toLocaleString()} BDT/day</strong> (or <strong>${safeWeekly.toLocaleString()} BDT/week</strong>). Keeping under that keeps your nest thriving! 🎍`;
  }

  // 9. BALANCE, INCOME, EXPENSE & SAVINGS RATE
  if (q.includes("balance") || q.includes("how much money") || q.includes("money left") || q.includes("net worth") || q.includes("summary") || q.includes("status") || q.includes("overview")) {
    const savingsRate = income > 0 ? Math.max(0, Math.round(((income - expense) / income) * 100)) : 0;
    return `Here is your live Financial Overview 🏡:<br>
    • <strong>Available Balance:</strong> ${balance.toLocaleString()} BDT<br>
    • <strong>Total Income:</strong> +${income.toLocaleString()} BDT<br>
    • <strong>Total Expenses:</strong> ${expense.toLocaleString()} BDT<br>
    • <strong>Net Savings Rate:</strong> ${savingsRate}% of your inflows saved! 🐼`;
  }
  if (q.includes("income") || q.includes("allowance") || q.includes("earned") || q.includes("inflow")) {
    return `You have logged <strong>+${income.toLocaleString()} BDT</strong> in total income and student allowances across ${txs.filter(t => t.type === "income").length} entries! 💵`;
  }
  if (q.includes("expense") || q.includes("total spent") || q.includes("outflow") || q.includes("how much did i spend")) {
    return `Your total expenses are <strong>${expense.toLocaleString()} BDT</strong> across ${txs.filter(t => t.type === "expense").length} logged expense transactions. 📋`;
  }
  if (q.includes("biggest") || q.includes("largest") || q.includes("most expensive") || q.includes("last transaction") || q.includes("recent")) {
    const expList = txs.filter(t => t.type === "expense");
    if (expList.length === 0) return `You haven't logged any expenses yet! Add one in Quick Add Transaction above. ➕`;
    const biggest = [...expList].sort((a, b) => Number(b.amount) - Number(a.amount))[0];
    const latest = txs[0];
    return `Your largest expense is <strong>"${escapeHTML(biggest.title)}" (${Number(biggest.amount).toLocaleString()} BDT)</strong> on ${formatReadableDate(biggest.date)}, and your most recent entry is <strong>"${escapeHTML(latest.title)}" (${Number(latest.amount).toLocaleString()} BDT)</strong>. 🕒`;
  }

  // 10. TOP SPENDING CATEGORY & BUDGET CHECKS
  if (q.includes("most") || q.includes("highest") || q.includes("where am i spending") || q.includes("top category") || q.includes("breakdown")) {
    const entries = Object.entries(catTotals);
    if (entries.length === 0) {
      return `No expenses logged yet! Click "📥 Load Sample Data" or add an expense to see your category ranking. 📊`;
    }
    entries.sort((a, b) => b[1] - a[1]);
    const [topCat, topAmt] = entries[0];
    return `Your top spending category is <strong>${topCat}</strong> at <strong>${topAmt.toLocaleString()} BDT</strong> (${Math.round((topAmt / Math.max(1, expense)) * 100)}% of total expenses). 📊`;
  }
  if (q.includes("budget") || q.includes("over budget") || q.includes("limit") || q.includes("cap")) {
    const overCats = Object.keys(budgets).filter(cat => (catTotals[cat] || 0) > budgets[cat]);
    const nearCats = Object.keys(budgets).filter(cat => {
      const s = catTotals[cat] || 0;
      return s >= budgets[cat] * 0.8 && s <= budgets[cat];
    });
    if (overCats.length > 0) {
      return `Alert! 🚨 You are over your monthly budget cap in: <strong>${overCats.join(", ")}</strong>. Check the Budgets tab to review!`;
    }
    if (nearCats.length > 0) {
      return `Heads up! ⚠️ You have used over 80% of your budget in: <strong>${nearCats.join(", ")}</strong>. Pacing carefully will keep you safe!`;
    }
    return `Yay! 🐼💚 You are comfortably within your monthly budget caps across all ${Object.keys(budgets).length} categories!`;
  }

  // 11. PERSONAL SAVINGS GOALS, HAPPY PIGGY & COZY NESTS
  if (q.includes("cozy nest") || q.includes("shared") || q.includes("friend") || q.includes("group") || q.includes("team") || q.includes("mate")) {
    return `You are currently part of <strong>${myNests.length} Cozy Nest(s)</strong>! 🪺 Open the <strong>Cozy Nests</strong> tab in the navbar to search existing users by Name or Email/ID, contribute to joint goals, and chat live!`;
  }
  if (q.includes("piggy") || q.includes("confetti") || q.includes("celebrat") || q.includes("reward")) {
    return `Whenever any personal goal on <strong>Savings Goals</strong> or shared goal on <strong>Cozy Nests</strong> reaches 100%, a multi-wave confetti shower and the bouncing <strong>Happy Piggy</strong> popup appear! 🐷🎉`;
  }
  if (q.includes("saving") || q.includes("goal") || q.includes("target") || q.includes("vault")) {
    if (goals.length === 0) {
      return `You don't have any personal savings goals yet. Head to <strong>Savings Goals</strong> to create one and deposit any custom amount! 🎯`;
    }
    const listStr = goals
      .map(g => {
        const pct = Math.min(100, Math.round((g.saved / g.target) * 100));
        const rem = Math.max(0, g.target - g.saved);
        return `<strong>${escapeHTML(g.title)}</strong> (${pct}% — need ${rem.toLocaleString()} BDT more)`;
      })
      .join("; ");
    return `Your active savings goals: ${listStr}. You can add any custom BDT amount on the Savings Goals page! 🏆`;
  }

  // 12. FINANCIAL CONCEPTS & STUDENT TIPS (50/30/20, Emergency Fund, Impulse Buying)
  if (q.includes("50/30/20") || q.includes("50 30 20") || q.includes("rule")) {
    const needs = Math.round(income * 0.5);
    const wants = Math.round(income * 0.3);
    const savePart = Math.round(income * 0.2);
    return `The <strong>50/30/20 Student Rule</strong> divides your ${income.toLocaleString()} BDT income into: <strong>50% Needs</strong> (${needs.toLocaleString()} BDT for Food/Transport/Study), <strong>30% Wants</strong> (${wants.toLocaleString()} BDT for Treats/Fun), and <strong>20% Savings</strong> (${savePart.toLocaleString()} BDT into your Savings Vault)! 📐`;
  }
  if (q.includes("emergency") || q.includes("medical") || q.includes("rainy day")) {
    return `Student Emergency Fund Tip 🛡️: Aim to keep at least <strong>3,000 to 5,000 BDT</strong> tucked in your Savings Goals for unexpected medical, travel, or academic needs!`;
  }
  if (q.includes("tip") || q.includes("advice") || q.includes("hack") || q.includes("save more") || q.includes("impulse") || q.includes("broke") || q.includes("stress") || q.includes("money") || q.includes("finance")) {
    const tips = [
      "Use the 24-Hour Rule: wait one full day before buying non-essential items over 300 BDT! ⏳",
      "Track small rickshaw fares and campus snacks daily—small leaks sink big allowances! 🚕",
      "Pay yourself first: move 10% of your allowance into Savings Goals the day you receive it! 🐷",
      "Share rides or group-buy stationery with friends using a joint goal in Cozy Nests! 🪺"
    ];
    return `💡 <strong>Penny AI Student Tip:</strong> ${tips[Math.floor(Math.random() * tips.length)]}`;
  }

  // 13. POLITE OFF-TOPIC FALLBACK REPLY (When user asks something outside PennyNest / Student Finance)
  return `Aww, I'm just a cozy finance panda, so that topic is a little outside my nest! 🐼🌿 You can ask me anything about <strong>PennyNest</strong>, your <strong>balance, daily allowance, category budgets, savings goals, Cozy Nests</strong>, or <strong>student money tips</strong>—or type <strong>"guide me"</strong> to see how I can help!`;
}

// ==========================================
// 12. RENDERING VIEWS (DASHBOARD WITHOUT MINUS SIGN ON EXPENSES)
// ==========================================

/* ---- refreshAllViews ---- */

function refreshAllViews() {
  if (!getCurrentUser()) return;
  renderAdminDashboard();
  renderDashboard();
  renderLedgerTable();
  renderBudgetBars();
  renderGoals();
  renderCompletedGoals();
  renderCozyNestsPage();
  renderInboxBadge();
}

/* ---- renderDashboard ---- */

function renderDashboard() {
  const profile = getCurrentUser();
  const greetingEl = document.getElementById("greetingHeader");
  if (profile && profile.name) {
    greetingEl.textContent = "Welcome to your nest! 🏡";
  } else {
    greetingEl.textContent = "Financial Overview";
  }

  const list = getTransactions();
  let income = 0, expense = 0;
  list.forEach(tx => {
    if (tx.type === "income") income += Number(tx.amount);
    else expense += Number(tx.amount);
  });

  const balance = income - expense;
  const safeDaily = Math.max(0, Math.round(balance / 15));

  document.getElementById("totalBalance").textContent = balance.toLocaleString() + " BDT";
  document.getElementById("totalIncome").textContent = "+" + income.toLocaleString() + " BDT";
  // Minus sign removed before Total Expenses as requested
  document.getElementById("totalExpense").textContent = expense.toLocaleString() + " BDT";
  document.getElementById("safeDailySpend").textContent = "Safe daily spend (next 15 days): " + safeDaily.toLocaleString() + " BDT/day";

  const piggyMsg = document.getElementById("piggyStatusMsg");
  if (balance > 5000) {
    piggyMsg.textContent = "Yay! Your nest is thriving and cozy. Keep up the mindful budgeting! 🏡";
  } else if (balance > 1000) {
    piggyMsg.textContent = "Doing steady! You have a healthy cushion for your daily campus essentials. 🌿";
  } else if (balance > 0) {
    piggyMsg.textContent = "Careful! Balance is running a bit low. Time to pause extra treats! 💡";
  } else {
    piggyMsg.textContent = "Oops! Your balance is at zero or negative. Time to budget closely! 🛡️";
  }

  const recentEl = document.getElementById("recentList");
  if (list.length === 0) {
    recentEl.innerHTML = '<li class="tx-item"><span class="tx-meta">No transactions yet. Add one on the left or click "📥 Load Sample Data"!</span></li>';
    return;
  }

  recentEl.innerHTML = list.slice(0, 5).map(tx => `
    <li class="tx-item">
      <div class="tx-info">
        <strong>${escapeHTML(tx.title)}</strong>
        <span class="tx-meta">${formatReadableDate(tx.date)} • ${tx.category}</span>
      </div>
      <span class="tx-amount ${tx.type === 'income' ? 'text-green' : 'text-red'}">
        ${tx.type === 'income' ? '+' : '-'}${Number(tx.amount).toLocaleString()} BDT
      </span>
    </li>
  `).join("");
}

/* ---- renderLedgerTable ---- */

function renderLedgerTable() {
  const tbody = document.getElementById("ledgerTableBody");
  if (!tbody) return;

  const query = (document.getElementById("searchInput").value || "").toLowerCase();
  const catFilter = document.getElementById("filterCategory").value;
  const monthFilter = document.getElementById("filterMonth").value;
  const typeFilter = document.getElementById("filterType").value;

  const dlBtn = document.getElementById("downloadByTypeBtn");
  if (dlBtn) {
    if (typeFilter === "income") dlBtn.textContent = "📥 Download Income Only (CSV)";
    else if (typeFilter === "expense") dlBtn.textContent = "📥 Download Expenses Only (CSV)";
    else dlBtn.textContent = "📥 Download All Types (CSV)";
  }

  // Uses the dynamic sample month adapter so sample data remains identical across any chosen month
  const sourceTransactions = getLedgerTransactionsWithDynamicSampleMonth(monthFilter);

  const filtered = sourceTransactions.filter(tx => {
    const matchesText = tx.title.toLowerCase().includes(query);
    const matchesCat = catFilter === "All" || tx.category === catFilter;
    const matchesMonth = !monthFilter || (tx.date && tx.date.startsWith(monthFilter));
    const matchesType = typeFilter === "All" || tx.type === typeFilter;
    return matchesText && matchesCat && matchesMonth && matchesType;
  });

  const summaryEl = document.getElementById("monthlySummaryText");
  if (summaryEl) {
    const typeText = typeFilter === "All" ? "all types" : `${typeFilter} records`;
    summaryEl.textContent = `Showing ${filtered.length} ${typeText}`;
  }

  if (filtered.length === 0) {
    tbody.innerHTML = '<tr><td colspan="6" style="text-align:center; color:var(--text-muted); padding:24px;">No matching transactions found for this filter.</td></tr>';
    return;
  }

  tbody.innerHTML = filtered.map(tx => `
    <tr>
      <td>${formatReadableDate(tx.date)}</td>
      <td><strong>${escapeHTML(tx.title)}</strong></td>
      <td><span class="badge">${tx.category}</span></td>
      <td>${tx.type === "income" ? "Income" : "Expense"}</td>
      <td class="tx-amount ${tx.type === 'income' ? 'text-green' : 'text-red'}">
        ${tx.type === "income" ? "+" : "-"}${Number(tx.amount).toLocaleString()} BDT
      </td>
      <td>
        <button type="button" class="btn btn-danger btn-sm" onclick="deleteTransaction(${tx.id})">Delete</button>
      </td>
    </tr>
  `).join("");
}

/* ---- renderBudgetBars ---- */

function renderBudgetBars() {
  const container = document.getElementById("budgetBarsContainer");
  if (!container) return;

  const budgets = getBudgets();
  const transactions = getTransactions();
  const spentByCat = {};

  transactions.forEach(tx => {
    if (tx.type === "expense") {
      spentByCat[tx.category] = (spentByCat[tx.category] || 0) + Number(tx.amount);
    }
  });

  if (Object.keys(budgets).length === 0) {
    container.innerHTML = '<p style="color:var(--text-muted);">No category budgets set. Add one on the left!</p>';
    return;
  }

  container.innerHTML = Object.keys(budgets).map(cat => {
    const limit = budgets[cat];
    const spent = spentByCat[cat] || 0;
    const pct = Math.min(100, Math.round((spent / limit) * 100));

    let barColor = "var(--primary)";
    let funStatus = "🐼 Cozy & well under your cap!";
    if (pct >= 100) {
      barColor = "var(--red)";
      funStatus = "🚨 Cap reached! Panda says pause spending here!";
    } else if (pct >= 80) {
      barColor = "var(--red)";
      funStatus = "⚠️ Getting close—tread lightly like a mindful panda!";
    } else if (pct >= 50) {
      barColor = "#f59e0b";
      funStatus = "🌿 Halfway through your monthly limit—pacing nicely!";
    }

    return `
      <div class="budget-item">
        <div class="budget-top">
          <strong>${cat}</strong>
          <div style="display:flex; align-items:center; gap:10px;">
            <span class="num-font">${spent.toLocaleString()} / ${limit.toLocaleString()} BDT (${pct}%)</span>
            <button type="button" class="btn btn-danger btn-sm" style="padding:2px 7px; font-size:0.75rem;" onclick="deleteBudgetCategory('${cat}')" title="Remove category">✕</button>
          </div>
        </div>
        <div class="progress-track">
          <div class="progress-fill" style="width:${pct}%; background:${barColor};"></div>
        </div>
        <div class="budget-fun-note">${funStatus}</div>
      </div>
    `;
  }).join("");
}

/* ---- renderGoals ---- */

function renderGoals() {
  const container = document.getElementById("goalsContainer");
  if (!container) return;

  // Completed goals move to the saved history section below
  const goals = getGoals().filter(g => !isGoalDone(g));

  if (goals.length === 0) {
    container.innerHTML = '<p style="color:var(--text-muted);">No active savings goals right now. Create one on the left!</p>';
    return;
  }

  container.innerHTML = goals.map(g => {
    const pct = Math.min(100, Math.round((g.saved / g.target) * 100));
    const isCompleted = g.saved >= g.target;

    return `
      <div class="goal-card">
        <div class="budget-top">
          <strong>${escapeHTML(g.title)}</strong>
          <span class="num-font">${g.saved.toLocaleString()} / ${g.target.toLocaleString()} BDT (${pct}%)</span>
        </div>
        <div class="progress-track">
          <div class="progress-fill" style="width:${pct}%; background:linear-gradient(90deg, var(--primary), var(--accent-secondary));"></div>
        </div>
        <div class="goal-custom-deposit">
          <input type="number" id="goalDepositInput_${g.id}" min="1" step="any" placeholder="Enter any BDT amount...">
          <button type="button" class="btn btn-primary btn-sm" onclick="handleCustomGoalDeposit(${g.id}, '${escapeHTML(g.title)}')">+ Add</button>
          <button type="button" class="btn btn-danger btn-sm" onclick="deleteGoal(${g.id})">Delete</button>
        </div>
      </div>
    `;
  }).join("");
}

// ==========================================
// 13. EXTRA-ENJOYABLE CONFETTI & HAPPY PIGGY CELEBRATION
// ==========================================

/* ---- triggerGoalCelebration ---- */

function triggerGoalCelebration(goalTitle) {
  launchConfettiShower();
  const modal = document.getElementById("happyPiggyModal");
  document.getElementById("happyPiggyTitle").textContent = `100% Achieved: ${goalTitle}!`;
  document.getElementById("happyPiggyDesc").textContent =
    `Look at Happy Piggy dance! You completed "${goalTitle}"—your discipline is paying off! 🐷🎉`;
  modal.classList.remove("hidden");
}

/* ---- closeHappyPiggyModal ---- */

function closeHappyPiggyModal() {
  document.getElementById("happyPiggyModal").classList.add("hidden");
}

/* ---- launchConfettiShower ---- */

function launchConfettiShower() {
  const colors = ["#10b981", "#84cc16", "#f59e0b", "#ec4899", "#38bdf8", "#a855f7", "#fb7185"];
  const emojis = ["🎉", "🐷", "🎋", "💚", "🌸", "🏡"];

  for (let i = 0; i < 85; i++) {
    const conf = document.createElement("div");
    conf.className = "confetti-piece";
    conf.style.left = Math.random() * 100 + "vw";

    if (i % 5 === 0) {
      conf.textContent = emojis[Math.floor(Math.random() * emojis.length)];
      conf.style.fontSize = Math.random() * 14 + 16 + "px";
    } else {
      conf.style.width = Math.random() * 8 + 7 + "px";
      conf.style.height = Math.random() * 12 + 10 + "px";
      conf.style.backgroundColor = colors[Math.floor(Math.random() * colors.length)];
      conf.style.borderRadius = Math.random() > 0.5 ? "50%" : "3px";
    }

    conf.style.animationDuration = Math.random() * 2 + 1.8 + "s";
    conf.style.animationDelay = Math.random() * 0.7 + "s";
    document.body.appendChild(conf);
    setTimeout(() => conf.remove(), 4200);
  }
}

/* ---- showToast ---- */

function showToast(message) {
  const existing = document.getElementById("customToast");
  if (existing) existing.remove();

  const toast = document.createElement("div");
  toast.id = "customToast";
  toast.className = "celebration-toast";
  toast.innerHTML = `<span>${message}</span>`;
  document.body.appendChild(toast);

  setTimeout(() => {
    toast.style.opacity = "0";
    toast.style.transition = "opacity 0.4s ease";
    setTimeout(() => toast.remove(), 400);
  }, 3000);
}

// ==========================================
// 14. COMPLETED-GOAL HISTORY, AVATAR-ONLY IDENTITY & ADMIN DATA EXPORTS
// ==========================================

/* ---- isGoalDone ---- */

function isGoalDone(g) {
  return Number(g.target) > 0 && Number(g.saved) >= Number(g.target);
}

/* ---- formatFullDate ---- */

function formatFullDate(iso) {
  if (!iso) return "Date not recorded";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "Date not recorded";
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });
}

// Small round profile picture for any user email (no name shown)

/* ---- renderCompletedGoals ---- */

function renderCompletedGoals() {
  const container = document.getElementById("completedGoalsContainer");
  if (!container) return;
  const done = getGoals().filter(isGoalDone);
  if (done.length === 0) {
    container.innerHTML = '<p class="completed-history-empty">No completed goals yet. Reach 100% and your goal will be saved here for future review.</p>';
    return;
  }
  container.innerHTML = done.map(g => `
    <div class="goal-card completed-card">
      <div class="budget-top">
        <strong>${escapeHTML(g.title)} 💙</strong>
        <span class="badge-done">✔ Completed</span>
      </div>
      <div class="progress-track"><div class="progress-fill done" style="width:100%;"></div></div>
      <p class="treat-sub" style="margin-top:8px;">
        Saved: <strong>${Number(g.saved).toLocaleString()} / ${Number(g.target).toLocaleString()} BDT</strong><br>
        Completed on: <strong>${formatFullDate(g.completedAt)}</strong>
      </p>
      <div class="goal-custom-deposit">
        <button type="button" class="btn btn-danger btn-sm" onclick="deleteGoal(${g.id})">Delete from history</button>
      </div>
    </div>
  `).join("");
}

/* ---- csvCell ---- */

function csvCell(v) {
  let s = v === null || v === undefined ? "" : String(v);
  // Guard against spreadsheet formula injection
  if (/^[=+\-@\t\r]/.test(s) && isNaN(Number(s))) s = "'" + s;
  return `"${s.replace(/"/g, '""')}"`;
}

/* ---- downloadTextFile ---- */

function downloadTextFile(filename, content, mime) {
  const blob = new Blob([content], { type: mime || "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.setAttribute("download", filename);
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/* ---- downloadCSV ---- */

function downloadCSV(filename, rows) {
  // BOM so Excel reads UTF-8 correctly
  const csv = "\uFEFF" + rows.map(r => r.map(csvCell).join(",")).join("\r\n");
  downloadTextFile(filename, csv, "text/csv;charset=utf-8;");
}

/* ---- escapeHTML ---- */

function escapeHTML(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/* ---- avatarChipByEmail (cache-backed, privacy-safe) ---- */

function avatarChipByEmail(email) {
  const key = String(email || "").toLowerCase();
  const avatar = state.avatarMap[key] || "🐼";
  return `<span class="mini-avatar" title="Nest mate">${renderAvatarVisual(avatar)}</span>`;
}

/* ---- chat signature helper used by polling ---- */

function currentChatSignature() {
  const nest = getAllCozyNests().find((n) => n.id === activeCozyNestId);
  if (!nest || !nest.messages) return "";
  return nest.id + ":" + nest.messages.length + ":" + (nest.messages[nest.messages.length - 1] || {}).text;
}

/* ==================== 3. ACTIONS ==================== */
/* ============================================================
   PENNYNEST — ACTIONS
   Every mutation goes through the API and then re-syncs the cache,
   so a second device sees the same data immediately.
   ============================================================ */

/* ---------------- transactions ---------------- */

async function handleSaveTransaction(e) {
  e.preventDefault();
  const title = document.getElementById("txTitle").value.trim();
  const amount = parseFloat(document.getElementById("txAmount").value);
  const type = document.getElementById("txType").value;
  const category = document.getElementById("txCategory").value;
  const date = document.getElementById("txDate").value || new Date().toISOString().split("T")[0];

  if (!title) return showToast("⚠️ Please add a description.");
  if (!(amount > 0)) return showToast("⚠️ Please enter an amount greater than zero.");

  const btn = document.querySelector("#quickAddForm button[type='submit']");
  if (btn) btn.disabled = true;
  try {
    await api("/transactions", { method: "POST", body: { title, amount, type, category, date } });
    document.getElementById("quickAddForm").reset();
    document.getElementById("txDate").value = new Date().toISOString().split("T")[0];

    const msg = document.getElementById("saveFeedback");
    if (msg) {
      msg.style.display = "block";
      setTimeout(() => (msg.style.display = "none"), 2500);
    }
    await syncAll({ quiet: true });
  } catch (err) {
    showToast("⚠️ " + err.message);
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function loadSampleData() {
  const user = getCurrentUser();
  if (!user) return;

  const today = new Date();
  const yyyyMm = today.toISOString().slice(0, 7);
  const dayStr = String(today.getDate()).padStart(2, "0");
  const base = { date: `${yyyyMm}-${dayStr}`, isSample: true, sampleDay: dayStr };

  const sample = [
    { ...base, title: "Monthly Allowance from Home", amount: 8000, type: "income", category: "Allowance" },
    { ...base, title: "University Canteen Lunch", amount: 180, type: "expense", category: "Food" },
    { ...base, title: "Rickshaw & Bus Commute", amount: 120, type: "expense", category: "Transport" },
    { ...base, title: "Data Pack Recharge", amount: 350, type: "expense", category: "Utilities" },
    { ...base, title: "Photocopy & Lab Sheets", amount: 220, type: "expense", category: "Education" }
  ];

  try {
    await api("/transactions/bulk", { method: "POST", body: { transactions: sample } });
    await syncAll({ quiet: true });
    showToast("📥 Sample student data loaded! Pick any month in the calendar to view it.");
  } catch (err) {
    showToast("⚠️ " + err.message);
  }
}

function deleteTransaction(id) {
  const tx = getTransactions().find((item) => item.id === id);
  const label = tx ? `"${tx.title}" (${tx.amount} BDT)` : "this transaction";

  openCuteModal({
    icon: "🧾🗑️",
    title: "Delete Transaction?",
    message: `Are you sure you want to remove ${label} from your ledger?`,
    confirmText: "Delete",
    cancelText: "Keep",
    isDanger: true,
    onConfirm: () =>
      mutate(() => api(`/transactions/${id}`, { method: "DELETE" }), "🗑️ Transaction deleted.")
  });
}

function clearAllHistory() {
  openCuteModal({
    icon: "🧹📋",
    title: "Clear All Transaction History?",
    message: "This removes every logged income and expense entry from your ledger on all devices. This cannot be undone!",
    confirmText: "Yes, Clear All",
    cancelText: "Cancel",
    isDanger: true,
    onConfirm: () => mutate(() => api("/transactions", { method: "DELETE" }), "🗑️ All transaction history cleared.")
  });
}

/* ---------------- budgets ---------------- */

async function handleUpdateBudget(e) {
  e.preventDefault();
  const cat = document.getElementById("budgetCategory").value;
  const limit = parseFloat(document.getElementById("budgetLimit").value);
  if (!(limit > 0)) return showToast("⚠️ Please enter a limit greater than zero.");

  try {
    await api("/budgets", { method: "PUT", body: { category: cat, limit } });
    document.getElementById("budgetForm").reset();
    await syncAll({ quiet: true });
    showToast(`⚙️ Budget limit for "${cat}" updated!`);
  } catch (err) {
    showToast("⚠️ " + err.message);
  }
}

function deleteBudgetCategory(categoryName) {
  openCuteModal({
    icon: "📊🗑️",
    title: "Remove Budget Limit?",
    message: `Remove the monthly spending cap for "${categoryName}"?`,
    confirmText: "Remove Cap",
    cancelText: "Cancel",
    isDanger: true,
    onConfirm: () =>
      mutate(
        () => api(`/budgets/${encodeURIComponent(categoryName)}`, { method: "DELETE" }),
        `🗑️ Removed budget limit for "${categoryName}".`
      )
  });
}

/* ---------------- goals ---------------- */

async function handleCreateGoal(e) {
  e.preventDefault();
  const title = document.getElementById("goalTitle").value.trim();
  const target = parseFloat(document.getElementById("goalTarget").value);
  const saved = parseFloat(document.getElementById("goalSaved").value) || 0;

  if (!title) return showToast("⚠️ Please name your goal.");
  if (!(target > 0)) return showToast("⚠️ Please enter a target above zero.");

  try {
    await api("/goals", { method: "POST", body: { title, target, saved } });
    document.getElementById("goalForm").reset();
    await syncAll({ quiet: true });
    if (saved >= target) triggerGoalCelebration(title);
    else showToast("🎯 New savings goal added to your Nest!");
  } catch (err) {
    showToast("⚠️ " + err.message);
  }
}

async function handleCustomGoalDeposit(id, goalTitle) {
  const inputEl = document.getElementById(`goalDepositInput_${id}`);
  const amount = parseFloat(inputEl ? inputEl.value : 0);

  if (!(amount > 0)) {
    openCuteModal({
      icon: "🐷💡",
      title: "Enter an Amount",
      message: "Please type a valid BDT amount in the box before clicking + Add!",
      confirmText: "Okay",
      showCancel: false
    });
    return;
  }

  try {
    const res = await api(`/goals/${id}/deposit`, { method: "POST", body: { amount } });
    await syncAll({ quiet: true });
    if (res && res.goal && res.goal.completedAt) triggerGoalCelebration(goalTitle);
    else showToast(`🏡 Added ${amount.toLocaleString()} BDT to "${goalTitle}"!`);
  } catch (err) {
    showToast("⚠️ " + err.message);
  }
}

function deleteGoal(id) {
  const goal = getGoals().find((g) => g.id === id);
  const label = goal ? `"${goal.title}"` : "this savings goal";

  openCuteModal({
    icon: "🎯🗑️",
    title: "Delete Savings Goal?",
    message: `Are you sure you want to delete the goal ${label}?`,
    confirmText: "Delete Goal",
    cancelText: "Keep Goal",
    isDanger: true,
    onConfirm: () => mutate(() => api(`/goals/${id}`, { method: "DELETE" }), "🗑️ Savings goal deleted.")
  });
}

/* ---------------- cozy nests ---------------- */

let memberSearchTimer = null;

function searchExistingUsersForNest() {
  const query = (document.getElementById("memberSearchInput").value || "").trim();
  const resultsBox = document.getElementById("userSearchResults");
  if (!resultsBox) return;

  if (memberSearchTimer) clearTimeout(memberSearchTimer);

  if (!query) {
    resultsBox.innerHTML = "";
    return;
  }

  resultsBox.innerHTML = `<div class="user-search-item"><span class="treat-sub">Searching…</span></div>`;

  memberSearchTimer = setTimeout(async () => {
    try {
      const data = await api(`/users/search?q=${encodeURIComponent(query)}`, { quiet: true });
      const matches = data.users || [];
      matches.forEach((u) => (state.avatarMap[u.email.toLowerCase()] = u.avatar || "🐼"));

      if (!matches.length) {
        resultsBox.innerHTML = `<div class="user-search-item"><span class="treat-sub">No registered user found matching "${escapeHTML(query)}"</span></div>`;
        return;
      }

      resultsBox.innerHTML = matches
        .map((u) => {
          const alreadyAdded = pendingNestMembers.includes(u.email.toLowerCase());
          return `
          <div class="user-search-item">
            <div>
              <span class="members-avatar-line">${avatarChipByEmail(u.email)} <span class="treat-sub">${escapeHTML(u.email)}</span></span>
            </div>
            ${
              alreadyAdded
                ? `<span class="badge">Added ✓</span>`
                : `<button type="button" class="btn btn-outline btn-sm" onclick="addMemberToPendingNest('${escapeAttr(u.email)}')">+ Add</button>`
            }
          </div>`;
        })
        .join("");
    } catch (err) {
      resultsBox.innerHTML = `<div class="user-search-item"><span class="treat-sub error-text">${escapeHTML(err.message)}</span></div>`;
    }
  }, 260);
}

async function handleCreateCozyNest(e) {
  e.preventDefault();
  const user = getCurrentUser();
  if (!user) return;

  const title = document.getElementById("nestTitleInput").value.trim();
  const target = parseFloat(document.getElementById("nestTargetInput").value);
  if (!title) return showToast("⚠️ Please name your Cozy Nest.");
  if (!(target > 0)) return showToast("⚠️ Please enter a joint target above zero.");

  if (!pendingNestMembers.includes(user.email.toLowerCase())) pendingNestMembers.unshift(user.email.toLowerCase());

  try {
    const res = await api("/nests", {
      method: "POST",
      body: { title, target, members: [...pendingNestMembers] }
    });
    document.getElementById("createNestForm").reset();
    pendingNestMembers = [user.email.toLowerCase()];
    activeCozyNestId = res && res.nest ? res.nest.id : null;
    await syncAll({ quiet: true });
    showToast(`🪺 Cozy Nest "${title}" created!`);
  } catch (err) {
    showToast("⚠️ " + err.message);
  }
}

async function handleContributeToNest(e) {
  e.preventDefault();
  const user = getCurrentUser();
  if (!user || !activeCozyNestId) return;

  const input = document.getElementById("nestContributeInput");
  const amount = parseFloat(input.value);
  if (!(amount > 0)) return showToast("⚠️ Please enter an amount above zero.");

  const nest = getAllCozyNests().find((n) => n.id === activeCozyNestId);
  const title = nest ? nest.title : "Cozy Nest";

  try {
    const res = await api(`/nests/${activeCozyNestId}/contribute`, { method: "POST", body: { amount } });
    input.value = "";
    await syncAll({ quiet: true });
    if (res && res.completed) triggerGoalCelebration(title);
    else showToast(`🪺 Added ${amount.toLocaleString()} BDT to "${title}"!`);
  } catch (err) {
    showToast("⚠️ " + err.message);
  }
}

async function handleInviteUserToActiveNest() {
  if (!activeCozyNestId) return;
  const inputEl = document.getElementById("inviteExistingUserInput");
  const query = (inputEl.value || "").trim().toLowerCase();
  if (!query) return showToast("⚠️ Type a name or email/ID first.");

  try {
    const res = await api(`/nests/${activeCozyNestId}/members`, { method: "POST", body: { email: query } });
    if (inputEl) inputEl.value = "";
    await syncAll({ quiet: true });
    showToast("🐼 Nest mate added to the Cozy Nest!");
    if (res && res.nest) activeCozyNestId = res.nest.id;
  } catch (err) {
    openCuteModal({
      icon: err.status === 404 ? "🔍🐼" : "🪺🐼",
      title: err.status === 404 ? "User Not Found" : "Could Not Add Mate",
      message: err.message,
      confirmText: "Okay",
      showCancel: false
    });
  }
}

async function handleSendNestChatMessage(e) {
  e.preventDefault();
  const user = getCurrentUser();
  if (!user || !activeCozyNestId) return;

  const input = document.getElementById("nestChatInput");
  const text = input.value.trim();
  if (!text) return;

  try {
    const res = await api(`/nests/${activeCozyNestId}/messages`, { method: "POST", body: { text } });
    input.value = "";
    const nest = getAllCozyNests().find((n) => n.id === activeCozyNestId);
    if (nest) nest.messages = res.messages || nest.messages;
    renderCozyNestsPage();
  } catch (err) {
    showToast("⚠️ " + err.message);
  }
}

function deleteActiveCozyNest() {
  if (!activeCozyNestId) return;
  const nest = getAllCozyNests().find((n) => n.id === activeCozyNestId);
  if (!nest) return;

  openCuteModal({
    icon: "🪺🗑️",
    title: "Delete Cozy Nest?",
    message: `Are you sure you want to delete the shared Cozy Nest "${nest.title}" for all members?`,
    confirmText: "Delete Cozy Nest",
    cancelText: "Cancel",
    isDanger: true,
    onConfirm: async () => {
      try {
        await api(`/nests/${activeCozyNestId}`, { method: "DELETE" });
        activeCozyNestId = null;
        await syncAll({ quiet: true });
        showToast("🗑️ Cozy Nest deleted.");
      } catch (err) {
        showToast("⚠️ " + err.message);
      }
    }
  });
}
