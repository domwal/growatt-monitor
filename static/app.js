const ALLOWED_INTERVALS = [5, 10, 30, 60];
const DEFAULT_INTERVAL = 5;
const REFRESH_STORAGE_KEY = "growatt-refresh-seconds";

let refreshSeconds = loadRefreshSeconds();
let pollTimer = null;

let vaultKey = null;
let vaultData = null;
let accounts = []; // [{id, label, username, password, plantId}] decriptado em memória
const cardRefs = new Map(); // accountId -> referências dos elementos do card

const dom = {
  accountsContainer: document.getElementById("accounts-container"),
  emptyState: document.getElementById("empty-state"),
  footerText: document.getElementById("footer-text"),
  accountsBtn: document.getElementById("accounts-btn"),
  logoutBtn: document.getElementById("logout-btn"),
  settingsBtn: document.getElementById("settings-btn"),
  settingsPanel: document.getElementById("settings-panel"),
  intervalOpts: Array.from(document.querySelectorAll(".interval-opt")),
  cardTemplate: document.getElementById("account-template"),

  vaultOverlay: document.getElementById("vault-overlay"),
  vaultTitle: document.getElementById("vault-title"),
  vaultText: document.getElementById("vault-text"),
  vaultForm: document.getElementById("vault-form"),
  vaultUsername: document.getElementById("vault-username"),
  vaultPassword: document.getElementById("vault-password"),
  vaultPasswordConfirm: document.getElementById("vault-password-confirm"),
  vaultError: document.getElementById("vault-error"),
  vaultSubmit: document.getElementById("vault-submit"),
  vaultReset: document.getElementById("vault-reset"),

  accountsOverlay: document.getElementById("accounts-overlay"),
  accountsClose: document.getElementById("accounts-close"),
  accountsList: document.getElementById("accounts-list"),
  accountForm: document.getElementById("account-form"),
  accountId: document.getElementById("account-id"),
  accountLabel: document.getElementById("account-label"),
  accountUsername: document.getElementById("account-username"),
  accountPassword: document.getElementById("account-password"),
  accountPlantId: document.getElementById("account-plant-id"),
  accountError: document.getElementById("account-error"),
  accountSubmit: document.getElementById("account-submit"),
  accountCancelEdit: document.getElementById("account-cancel-edit"),

  vsForm: document.getElementById("vault-settings-form"),
  vsUsername: document.getElementById("vs-username"),
  vsPassword: document.getElementById("vs-password"),
  vsPasswordConfirm: document.getElementById("vs-password-confirm"),
  vsError: document.getElementById("vs-error"),
  vsSuccess: document.getElementById("vs-success"),
};

let vaultMode = "create"; // "create" | "unlock"

// ---------- utilidades ----------

function loadRefreshSeconds() {
  try {
    const saved = Number(localStorage.getItem(REFRESH_STORAGE_KEY));
    if (ALLOWED_INTERVALS.includes(saved)) return saved;
  } catch (err) {
    // ignora
  }
  return DEFAULT_INTERVAL;
}

function saveRefreshSeconds(seconds) {
  try {
    localStorage.setItem(REFRESH_STORAGE_KEY, String(seconds));
  } catch (err) {
    // ignora
  }
}

function formatNumber(value, digits = 0) {
  if (value === null || value === undefined || Number.isNaN(value)) return "--";
  return value.toLocaleString("pt-BR", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

function formatTime(isoString) {
  if (!isoString) return "—";
  return new Date(isoString).toLocaleTimeString("pt-BR");
}

// ---------- painel de intervalo (engrenagem) ----------

function updateIntervalOptionsUI() {
  dom.intervalOpts.forEach((btn) => {
    btn.setAttribute("aria-checked", String(Number(btn.dataset.seconds) === refreshSeconds));
  });
}

function openSettings() {
  dom.settingsPanel.hidden = false;
  dom.settingsBtn.setAttribute("aria-expanded", "true");
}

function closeSettings() {
  dom.settingsPanel.hidden = true;
  dom.settingsBtn.setAttribute("aria-expanded", "false");
}

function wireSettingsGear() {
  dom.settingsBtn.addEventListener("click", (event) => {
    event.stopPropagation();
    if (dom.settingsPanel.hidden) openSettings();
    else closeSettings();
  });

  dom.intervalOpts.forEach((btn) => {
    btn.addEventListener("click", () => {
      const seconds = Number(btn.dataset.seconds);
      if (ALLOWED_INTERVALS.includes(seconds) && seconds !== refreshSeconds) {
        refreshSeconds = seconds;
        saveRefreshSeconds(seconds);
        updateIntervalOptionsUI();
        updateFooterText();
        restartPolling();
      }
      closeSettings();
    });
  });

  document.addEventListener("click", (event) => {
    if (!dom.settingsPanel.hidden && !dom.settingsPanel.contains(event.target) && event.target !== dom.settingsBtn) {
      closeSettings();
    }
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      closeSettings();
      closeAccountsOverlay();
    }
  });

  updateIntervalOptionsUI();
}

function updateFooterText() {
  dom.footerText.textContent = `Painel atualiza a cada ${refreshSeconds}s`;
}

// ---------- vault (senha mestre) ----------

function showVaultOverlay(mode) {
  vaultMode = mode;
  dom.vaultForm.reset();
  dom.vaultError.hidden = true;
  if (mode === "create") {
    dom.vaultTitle.textContent = "Criar senha mestre";
    dom.vaultText.textContent =
      "Essa senha criptografa os logins da Growatt salvos neste navegador. Ela não é enviada a " +
      "lugar nenhum — se você esquecê-la, será preciso resetar e cadastrar as contas de novo.";
    dom.vaultPasswordConfirm.hidden = false;
    dom.vaultPasswordConfirm.required = true;
    dom.vaultSubmit.textContent = "Criar vault";
    dom.vaultReset.hidden = true;
    dom.vaultUsername.value = "";
  } else {
    dom.vaultTitle.textContent = "Desbloquear contas salvas";
    dom.vaultText.textContent = "Digite seu usuário e senha mestre para acessar as contas Growatt salvas neste navegador.";
    dom.vaultPasswordConfirm.hidden = true;
    dom.vaultPasswordConfirm.required = false;
    dom.vaultSubmit.textContent = "Desbloquear";
    dom.vaultReset.hidden = false;
    dom.vaultUsername.value = Vault.getUsername();
  }
  dom.vaultOverlay.hidden = false;
  if (mode === "unlock" && dom.vaultUsername.value) {
    dom.vaultPassword.focus();
  } else {
    dom.vaultUsername.focus();
  }
}

function hideVaultOverlay() {
  dom.vaultOverlay.hidden = true;
}

function wireVaultOverlay() {
  dom.vaultForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    dom.vaultError.hidden = true;
    const username = dom.vaultUsername.value.trim();
    const password = dom.vaultPassword.value;

    try {
      if (!username) {
        throw new Error("Informe um nome de usuário.");
      }
      if (vaultMode === "create") {
        if (password.length < 8) {
          throw new Error("Use uma senha mestre com pelo menos 8 caracteres.");
        }
        if (password !== dom.vaultPasswordConfirm.value) {
          throw new Error("As senhas não coincidem.");
        }
        const result = await Vault.create(username, password);
        vaultKey = result.key;
        vaultData = result.vault;
      } else {
        const result = await Vault.unlock(username, password);
        vaultKey = result.key;
        vaultData = result.vault;
      }
    } catch (err) {
      dom.vaultError.textContent = err.message || String(err);
      dom.vaultError.hidden = false;
      return;
    }

    await Vault.persistSession(vaultKey);
    await onUnlocked();
  });

  dom.vaultReset.addEventListener("click", () => {
    const sure = confirm(
      "Isso vai apagar todas as contas Growatt salvas neste navegador (não é possível desfazer). Continuar?"
    );
    if (!sure) return;
    Vault.reset();
    showVaultOverlay("create");
  });
}

async function onUnlocked() {
  hideVaultOverlay();
  dom.accountsBtn.hidden = false;
  dom.logoutBtn.hidden = false;
  accounts = await Vault.listAccounts(vaultData, vaultKey);
  renderAccountsList();
  renderDashboardSkeleton();
  updateFooterText();
  await pushAllAccountsToBackend();
  restartPolling();
}

function logout() {
  Vault.clearSession();
  vaultKey = null;
  vaultData = null;
  accounts = [];
  cardRefs.clear();

  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }

  dom.accountsContainer.innerHTML = "";
  dom.accountsContainer.hidden = true;
  dom.emptyState.hidden = true;
  dom.accountsBtn.hidden = true;
  dom.logoutBtn.hidden = true;
  closeAccountsOverlay();

  showVaultOverlay("unlock");
}

// ---------- gerenciamento de contas ----------

function resetAccountForm() {
  dom.accountForm.reset();
  dom.accountId.value = "";
  dom.accountError.hidden = true;
  dom.accountSubmit.textContent = "Adicionar conta";
  dom.accountCancelEdit.hidden = true;
}

function openAccountsOverlay() {
  dom.accountsOverlay.hidden = false;
  dom.vsUsername.value = vaultData.username || "";
  dom.vsPassword.value = "";
  dom.vsPasswordConfirm.value = "";
  dom.vsError.hidden = true;
  dom.vsSuccess.hidden = true;
  renderAccountsList();
}

function closeAccountsOverlay() {
  dom.accountsOverlay.hidden = true;
}

function renderAccountsList() {
  dom.accountsList.innerHTML = "";
  if (accounts.length === 0) {
    const li = document.createElement("li");
    li.className = "account-row";
    li.textContent = "Nenhuma conta cadastrada ainda.";
    dom.accountsList.appendChild(li);
    return;
  }

  for (const acc of accounts) {
    const li = document.createElement("li");
    li.className = "account-row";

    const info = document.createElement("div");
    info.className = "account-row-info";
    const label = document.createElement("div");
    label.className = "account-row-label";
    label.textContent = acc.label;
    const username = document.createElement("div");
    username.className = "account-row-username";
    username.textContent = acc.username;
    info.appendChild(label);
    info.appendChild(username);

    const actions = document.createElement("div");
    actions.className = "account-row-actions";

    const editBtn = document.createElement("button");
    editBtn.type = "button";
    editBtn.textContent = "Editar";
    editBtn.addEventListener("click", () => startEditAccount(acc.id));

    const removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.textContent = "Remover";
    removeBtn.addEventListener("click", () => removeAccountById(acc.id));

    actions.appendChild(editBtn);
    actions.appendChild(removeBtn);

    li.appendChild(info);
    li.appendChild(actions);
    dom.accountsList.appendChild(li);
  }
}

function startEditAccount(accountId) {
  const acc = accounts.find((a) => a.id === accountId);
  if (!acc) return;
  dom.accountId.value = acc.id;
  dom.accountLabel.value = acc.label || "";
  dom.accountUsername.value = acc.username || "";
  dom.accountPassword.value = acc.password || "";
  dom.accountPlantId.value = acc.plantId || "";
  dom.accountSubmit.textContent = "Salvar alterações";
  dom.accountCancelEdit.hidden = false;
  dom.accountError.hidden = true;
  dom.accountUsername.focus();
}

async function removeAccountById(accountId) {
  const acc = accounts.find((a) => a.id === accountId);
  if (!acc) return;
  const sure = confirm(`Remover a conta "${acc.label}"?`);
  if (!sure) return;

  accounts = accounts.filter((a) => a.id !== accountId);
  Vault.removeAccount(vaultData, accountId);

  try {
    await fetch(`/api/accounts/${encodeURIComponent(accountId)}`, { method: "DELETE" });
  } catch (err) {
    // backend local pode estar fora do ar; a conta já foi removida do vault.
  }

  renderAccountsList();
  renderDashboardSkeleton();
}

async function pushAccount(acc) {
  try {
    await fetch("/api/accounts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: acc.id,
        label: acc.label,
        username: acc.username,
        password: acc.password,
        plant_id: acc.plantId || null,
      }),
    });
  } catch (err) {
    // sem conexão com o backend local agora; o próximo poll() tenta de novo.
  }
}

async function pushAllAccountsToBackend() {
  await Promise.all(accounts.map(pushAccount));
}

function wireAccountsOverlay() {
  dom.accountsBtn.addEventListener("click", openAccountsOverlay);
  dom.accountsClose.addEventListener("click", closeAccountsOverlay);
  dom.accountCancelEdit.addEventListener("click", resetAccountForm);
  dom.logoutBtn.addEventListener("click", logout);

  dom.accountsOverlay.addEventListener("click", (event) => {
    if (event.target === dom.accountsOverlay) closeAccountsOverlay();
  });

  dom.vsForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    dom.vsError.hidden = true;
    dom.vsSuccess.hidden = true;

    const newUsername = dom.vsUsername.value.trim();
    const newPassword = dom.vsPassword.value;
    const newPasswordConfirm = dom.vsPasswordConfirm.value;

    try {
      if (!newUsername) {
        throw new Error("Informe um nome de usuário.");
      }
      if (newPassword || newPasswordConfirm) {
        if (newPassword.length < 8) {
          throw new Error("A nova senha deve ter pelo menos 8 caracteres.");
        }
        if (newPassword !== newPasswordConfirm) {
          throw new Error("As senhas não coincidem.");
        }
        vaultKey = await Vault.changePassword(vaultData, vaultKey, newPassword);
        await Vault.persistSession(vaultKey);
      }
      if (newUsername !== vaultData.username) {
        Vault.renameUser(vaultData, newUsername);
      }
      dom.vsPassword.value = "";
      dom.vsPasswordConfirm.value = "";
      dom.vsSuccess.hidden = false;
    } catch (err) {
      dom.vsError.textContent = err.message || String(err);
      dom.vsError.hidden = false;
    }
  });

  dom.accountForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    dom.accountError.hidden = true;

    const username = dom.accountUsername.value.trim();
    const password = dom.accountPassword.value;
    if (!username || !password) {
      dom.accountError.textContent = "Usuário e senha são obrigatórios.";
      dom.accountError.hidden = false;
      return;
    }

    const id = dom.accountId.value || crypto.randomUUID();
    const label = dom.accountLabel.value.trim() || username;
    const plantId = dom.accountPlantId.value.trim() || null;
    const account = { id, label, username, password, plantId };

    const previousSubmitText = dom.accountSubmit.textContent;
    dom.accountSubmit.disabled = true;
    dom.accountSubmit.textContent = "Salvando…";

    try {
      await Vault.upsertAccount(vaultData, vaultKey, account);

      const idx = accounts.findIndex((a) => a.id === id);
      if (idx >= 0) accounts[idx] = account;
      else accounts.push(account);

      await pushAccount(account);

      resetAccountForm();
      renderAccountsList();
      renderDashboardSkeleton();
    } catch (err) {
      dom.accountError.textContent = "Não foi possível salvar: " + (err.message || err);
      dom.accountError.hidden = false;
    } finally {
      dom.accountSubmit.disabled = false;
      if (!dom.accountError.hidden) dom.accountSubmit.textContent = previousSubmitText;
    }
  });
}

// ---------- dashboard (um card por conta) ----------

function renderDashboardSkeleton() {
  dom.accountsContainer.innerHTML = "";
  cardRefs.clear();

  if (accounts.length === 0) {
    dom.accountsContainer.hidden = true;
    dom.emptyState.hidden = false;
    return;
  }

  dom.emptyState.hidden = true;
  dom.accountsContainer.hidden = false;

  for (const acc of accounts) {
    const node = dom.cardTemplate.content.firstElementChild.cloneNode(true);
    node.dataset.accountId = acc.id;
    const refs = {
      dot: node.querySelector(".brand-dot"),
      label: node.querySelector(".account-label"),
      plantName: node.querySelector(".plant-name"),
      gauge: node.querySelector(".gauge"),
      power: node.querySelector(".power-number"),
      today: node.querySelector(".today-value"),
      total: node.querySelector(".total-value"),
      nominal: node.querySelector(".nominal-value"),
      footer: node.querySelector(".account-footer"),
    };
    refs.label.textContent = acc.label;
    dom.accountsContainer.appendChild(node);
    cardRefs.set(acc.id, refs);
  }
}

function renderAccountState(refs, state) {
  const online = Boolean(state.connected);
  refs.dot.classList.toggle("online", online);
  refs.dot.classList.toggle("offline", !online);
  refs.plantName.textContent = state.plant_name || "";

  const power = state.current_power_w;
  refs.power.textContent = formatNumber(power, 0);

  const nominal = state.nominal_power_w;
  refs.nominal.textContent = formatNumber(nominal, 0);

  const pct = nominal && power ? Math.min(100, Math.max(0, (power / nominal) * 100)) : 0;
  refs.gauge.style.setProperty("--pct", pct.toFixed(1));

  refs.today.textContent = formatNumber(state.today_energy_kwh, 1);
  refs.total.textContent = formatNumber(state.total_energy_kwh, 1);

  refs.footer.classList.toggle("error", !online);
  if (online) {
    refs.footer.textContent = `Atualizado às ${formatTime(state.last_update)}`;
  } else {
    refs.footer.textContent = state.error ? `Sem conexão: ${state.error}` : "Conectando…";
  }
}

async function poll() {
  let data;
  try {
    const res = await fetch("/api/status", { cache: "no-store" });
    data = await res.json();
  } catch (err) {
    for (const refs of cardRefs.values()) {
      refs.dot.classList.remove("online");
      refs.dot.classList.add("offline");
      refs.footer.classList.add("error");
      refs.footer.textContent = "Não foi possível falar com o servidor local.";
    }
    return;
  }

  const serverAccounts = data.accounts || {};
  for (const acc of accounts) {
    const refs = cardRefs.get(acc.id);
    if (!refs) continue;
    const state = serverAccounts[acc.id];
    if (!state) {
      // Backend ainda não conhece essa conta (ex.: processo reiniciou) — reenvia as credenciais.
      pushAccount(acc);
      refs.footer.textContent = "Conectando…";
      continue;
    }
    renderAccountState(refs, state);
  }
}

function restartPolling() {
  if (pollTimer) clearInterval(pollTimer);
  poll();
  pollTimer = setInterval(poll, refreshSeconds * 1000);
}

// ---------- inicialização ----------

function init() {
  if (!window.crypto || !window.crypto.subtle) {
    const localUrl = `${location.protocol}//localhost:${location.port}${location.pathname}`;
    dom.footerText.innerHTML =
      "Este navegador só libera criptografia (Web Crypto) em http://localhost ou https://. " +
      `Acesse <a href="${localUrl}">${localUrl}</a> em vez do IP/hostname atual.`;
    return;
  }

  wireSettingsGear();
  wireVaultOverlay();
  wireAccountsOverlay();

  Vault.resumeSession().then((resumed) => {
    if (resumed) {
      vaultKey = resumed.key;
      vaultData = resumed.vault;
      onUnlocked();
    } else {
      showVaultOverlay(Vault.exists() ? "unlock" : "create");
    }
  });
}

document.addEventListener("DOMContentLoaded", init);
