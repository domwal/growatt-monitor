/**
 * Vault local: guarda as contas Growatt (usuário/senha) no localStorage do
 * navegador, criptografadas com AES-GCM. A chave é derivada (PBKDF2) de uma
 * senha mestre.
 *
 * Isso protege o conteúdo salvo contra quem abrir o localStorage (ex.: outra
 * pessoa com acesso ao perfil do navegador), mas não contra alguém que já
 * tenha a senha mestre ou controle total da aba desbloqueada — é o mesmo
 * modelo usado por gerenciadores de senha "locais".
 *
 * Para evitar pedir a senha a cada F5, a chave desbloqueada também é
 * guardada no sessionStorage (não no localStorage): sobrevive a recarregar
 * a página, mas é esquecida ao fechar a aba/navegador ou ao clicar em
 * "Sair".
 */

const VAULT_KEY = "growatt_vault_v1";
const SESSION_KEY = "growatt_vault_session_v1";
const PBKDF2_ITERATIONS = 210000;
const CHECK_PLAINTEXT = "growatt-vault-ok";

function toBase64(bytes) {
  return btoa(String.fromCharCode(...new Uint8Array(bytes)));
}

function fromBase64(str) {
  return Uint8Array.from(atob(str), (c) => c.charCodeAt(0));
}

function randomBytes(len) {
  return crypto.getRandomValues(new Uint8Array(len));
}

async function deriveKey(password, saltBytes, iterations) {
  const baseKey = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveKey"]
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: saltBytes, iterations, hash: "SHA-256" },
    baseKey,
    { name: "AES-GCM", length: 256 },
    true, // extraível: precisamos exportar a chave para guardar a sessão (ver persistSession)
    ["encrypt", "decrypt"]
  );
}

async function encryptText(key, plaintext) {
  const iv = randomBytes(12);
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    new TextEncoder().encode(plaintext)
  );
  return { iv: toBase64(iv), ct: toBase64(ct) };
}

async function decryptText(key, ivB64, ctB64) {
  const plaintextBuf = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: fromBase64(ivB64) },
    key,
    fromBase64(ctB64)
  );
  return new TextDecoder().decode(plaintextBuf);
}

function loadRawVault() {
  try {
    const raw = localStorage.getItem(VAULT_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (err) {
    return null;
  }
}

function saveRawVault(vault) {
  localStorage.setItem(VAULT_KEY, JSON.stringify(vault));
}

const Vault = {
  exists() {
    return loadRawVault() !== null;
  },

  /** Cria um vault novo (vazio) protegido por usuário + senha mestre. */
  async create(username, masterPassword) {
    const salt = randomBytes(16);
    const key = await deriveKey(masterPassword, salt, PBKDF2_ITERATIONS);
    const check = await encryptText(key, CHECK_PLAINTEXT);
    const vault = {
      username,
      salt: toBase64(salt),
      iterations: PBKDF2_ITERATIONS,
      check,
      accounts: [],
    };
    saveRawVault(vault);
    return { key, vault };
  },

  /** Nome de usuário salvo no vault (não é secreto, só identifica/pré-preenche a tela). */
  getUsername() {
    const vault = loadRawVault();
    return vault ? vault.username || "" : "";
  },

  /** Destrava o vault existente. Lança erro se usuário/senha estiverem errados. */
  async unlock(username, masterPassword) {
    const vault = loadRawVault();
    if (!vault) throw new Error("Nenhum vault encontrado.");
    if (vault.username && username !== vault.username) {
      throw new Error("Usuário ou senha incorretos.");
    }
    const salt = fromBase64(vault.salt);
    const key = await deriveKey(masterPassword, salt, vault.iterations);
    let decoded;
    try {
      decoded = await decryptText(key, vault.check.iv, vault.check.ct);
    } catch (err) {
      throw new Error("Usuário ou senha incorretos.");
    }
    if (decoded !== CHECK_PLAINTEXT) throw new Error("Usuário ou senha incorretos.");
    return { key, vault };
  },

  /** Decripta todas as contas salvas: [{id, label, username, password, plantId}] */
  async listAccounts(vault, key) {
    const results = [];
    for (const entry of vault.accounts) {
      try {
        const json = await decryptText(key, entry.iv, entry.ct);
        results.push({ id: entry.id, label: entry.label, ...JSON.parse(json) });
      } catch (err) {
        // Entrada corrompida/ilegível: ignora em vez de travar o app.
      }
    }
    return results;
  },

  /** Cria ou atualiza uma conta (por id) e persiste o vault. */
  async upsertAccount(vault, key, account) {
    const { id, label, ...secret } = account;
    const { iv, ct } = await encryptText(key, JSON.stringify(secret));
    const idx = vault.accounts.findIndex((a) => a.id === id);
    const entry = { id, label, iv, ct };
    if (idx >= 0) vault.accounts[idx] = entry;
    else vault.accounts.push(entry);
    saveRawVault(vault);
  },

  removeAccount(vault, id) {
    vault.accounts = vault.accounts.filter((a) => a.id !== id);
    saveRawVault(vault);
  },

  /** Troca só o nome de usuário exibido/validado no desbloqueio. */
  renameUser(vault, newUsername) {
    vault.username = newUsername;
    saveRawVault(vault);
  },

  /**
   * Troca a senha mestre: decripta todas as contas com a chave atual e
   * re-criptografa tudo com uma chave nova (salt novo). Retorna a nova
   * CryptoKey, que o chamador deve passar a usar.
   */
  async changePassword(vault, currentKey, newPassword) {
    const decrypted = [];
    for (const entry of vault.accounts) {
      const json = await decryptText(currentKey, entry.iv, entry.ct);
      decrypted.push({ id: entry.id, label: entry.label, json });
    }

    const salt = randomBytes(16);
    const newKey = await deriveKey(newPassword, salt, PBKDF2_ITERATIONS);
    const check = await encryptText(newKey, CHECK_PLAINTEXT);

    const newAccounts = [];
    for (const entry of decrypted) {
      const { iv, ct } = await encryptText(newKey, entry.json);
      newAccounts.push({ id: entry.id, label: entry.label, iv, ct });
    }

    vault.salt = toBase64(salt);
    vault.iterations = PBKDF2_ITERATIONS;
    vault.check = check;
    vault.accounts = newAccounts;
    saveRawVault(vault);
    return newKey;
  },

  reset() {
    localStorage.removeItem(VAULT_KEY);
    Vault.clearSession();
  },

  /** Guarda a chave desbloqueada no sessionStorage (sobrevive a F5, não ao fechar a aba). */
  async persistSession(key) {
    try {
      const raw = await crypto.subtle.exportKey("raw", key);
      sessionStorage.setItem(SESSION_KEY, toBase64(raw));
    } catch (err) {
      // sessionStorage indisponível (ex.: navegação privada) — apenas não persiste.
    }
  },

  clearSession() {
    try {
      sessionStorage.removeItem(SESSION_KEY);
    } catch (err) {
      // ignora
    }
  },

  /** Tenta retomar a sessão salva no sessionStorage. Retorna null se não houver/for inválida. */
  async resumeSession() {
    let raw;
    try {
      raw = sessionStorage.getItem(SESSION_KEY);
    } catch (err) {
      return null;
    }
    if (!raw) return null;

    const vault = loadRawVault();
    if (!vault) return null;

    try {
      const key = await crypto.subtle.importKey("raw", fromBase64(raw), "AES-GCM", false, [
        "encrypt",
        "decrypt",
      ]);
      const decoded = await decryptText(key, vault.check.iv, vault.check.ct);
      if (decoded !== CHECK_PLAINTEXT) return null;
      return { key, vault };
    } catch (err) {
      return null;
    }
  },
};
