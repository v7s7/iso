// public/api.js
//
// The only place in the front end that talks to the server.
//
// Everything else in app.js still works from one plain snapshot object, exactly
// as it did when that object came out of localStorage — the views, the filters,
// the charts and the Excel export were not touched. What changed is where the
// snapshot comes from and what happens when something is written: the server
// now holds the data and decides what is allowed, and the browser asks.
//
// Three things this layer is responsible for:
//
//   1. The token. Held in sessionStorage, so closing the tab ends the session
//      and two tabs can hold two different sign-ins.
//   2. Silent renewal. The server reissues a token past the halfway point of its
//      life and returns it in X-Renewed-Token; swapping it in here is what keeps
//      somebody working all day from being thrown back to the login screen.
//   3. Turning a failure into something the UI can show. A refusal from the
//      server arrives with an Arabic message written for the person reading it,
//      and that message is what gets thrown.

const API = (() => {
  const TOKEN_KEY = 'iso_token_v1';

  const getToken = () => { try { return sessionStorage.getItem(TOKEN_KEY) || null; } catch { return null; } };
  const setToken = (t) => { try { t ? sessionStorage.setItem(TOKEN_KEY, t) : sessionStorage.removeItem(TOKEN_KEY); } catch {} };

  // Raised when the server refuses. `.status` lets a caller tell "you may not do
  // that" (403) from "your session ended" (401) without parsing the message.
  class ApiError extends Error {
    constructor(message, status, code) {
      super(message);
      this.name = 'ApiError';
      this.status = status;
      this.code = code;
    }
  }

  // Called when a request comes back 401. app.js installs a handler that drops
  // to the login screen — the alternative is a page that silently renders empty
  // and looks like data loss.
  let onSessionLost = () => {};

  async function request(path, { method = 'GET', body } = {}) {
    const token = getToken();
    let res;
    try {
      res = await fetch(path, {
        method,
        headers: {
          ...(body ? { 'Content-Type': 'application/json' } : {}),
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch {
      // fetch only rejects when the request never got an answer — the server is
      // down, or the machine is off the network. Worth saying plainly, because
      // it is not the user's mistake and retrying the form will not help.
      throw new ApiError('تعذّر الاتصال بالخادم. تأكد من تشغيله ثم أعد المحاولة.', 0, 'NETWORK');
    }

    // Sliding session: the server hands back a fresh token when the current one
    // is past halfway. Same jti, so a forced sign-out still reaches it.
    const renewed = res.headers.get('X-Renewed-Token');
    if (renewed) setToken(renewed);

    let data = null;
    try { data = await res.json(); } catch {}

    if (res.status === 401) {
      setToken(null);
      onSessionLost(data?.message || 'انتهت الجلسة. يرجى تسجيل الدخول من جديد.');
      throw new ApiError(data?.message || 'انتهت الجلسة.', 401, data?.code);
    }
    if (!res.ok || data?.success === false) {
      throw new ApiError(data?.message || `فشل الطلب (${res.status}).`, res.status, data?.code);
    }
    return data;
  }

  const get  = (p)      => request(p);
  const post = (p, b)   => request(p, { method: 'POST', body: b });
  const put  = (p, b)   => request(p, { method: 'PUT',  body: b });
  const del  = (p)      => request(p, { method: 'DELETE' });

  return {
    ApiError,
    isSignedIn: () => !!getToken(),
    onSessionLost: (fn) => { onSessionLost = fn; },

    // ── Session ──
    async login(identifier, password) {
      // No token is sent for this one, and none is kept from a previous sign-in.
      setToken(null);
      const r = await post('/api/auth/login', { identifier, password });
      setToken(r.token);
      return r;
    },
    async logout() {
      // The server deletes the session row; that — not clearing storage here —
      // is what actually stops the token working.
      try { await post('/api/auth/logout'); } catch {}
      setToken(null);
    },
    // Only the forced first change — the server refuses this endpoint for any
    // other reason, because passwords are set by مدير النظام on the المستخدمون
    // screen. The current password is not asked for: it is the temporary one the
    // administrator just chose.
    changePassword: (password, confirmPassword) =>
      post('/api/auth/password', { password, confirmPassword }),

    // ── The snapshot every view renders from ──
    bootstrap: () => get('/api/bootstrap'),

    // ── Requests ──
    createRequest: (payload)      => post('/api/requests', payload),
    closeRequest:  (code, payload) => post(`/api/requests/${encodeURIComponent(code)}/close`, payload),
    getRequest:    (code)          => get(`/api/requests/${encodeURIComponent(code)}`),

    // ── إدارة النظام ──
    users:            ()          => get('/api/users'),
    createUser:       (p)         => post('/api/users', p),
    updateUser:       (id, p)     => put(`/api/users/${id}`, p),
    toggleUser:       (id)        => post(`/api/users/${id}/toggle`),
    resetUserPassword:(id, pw)    => post(`/api/users/${id}/reset-password`, { password: pw }),
    // Undoes the one above for an AD account: deletes the local password so the
    // directory decides again. The server refuses it for a row that was never
    // AD-linked, and when no directory is configured.
    revertUserToDirectory:(id)    => post(`/api/users/${id}/revert-to-directory`),

    createDepartment: (p)         => post('/api/departments', p),
    updateDepartment: (id, p)     => put(`/api/departments/${id}`, p),
    toggleDepartment: (id)        => post(`/api/departments/${id}/toggle`),

    createService:    (p)         => post('/api/services', p),
    updateService:    (id, p)     => put(`/api/services/${id}`, p),
    toggleService:    (id)        => post(`/api/services/${id}/toggle`),

    createHoliday:    (p)         => post('/api/holidays', p),
    updateHoliday:    (id, p)     => put(`/api/holidays/${id}`, p),
    deleteHoliday:    (id)        => del(`/api/holidays/${id}`),

    audit:            (q = '')    => get(`/api/audit?limit=500${q ? `&search=${encodeURIComponent(q)}` : ''}`),

    // ── Active Directory ──
    directory:        ()          => get('/api/users/directory'),
    importUser:       (p)         => post('/api/users/import', p),
  };
})();
