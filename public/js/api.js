/* Thin fetch wrapper: JSON in, JSON out, errors as exceptions. */

async function request(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  if (res.status === 204) return null;

  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* non-JSON error page */ }

  if (!res.ok) {
    const err = new Error(data?.error ?? `Request failed (${res.status})`);
    err.status = res.status;
    err.details = data?.details;
    throw err;
  }
  return data;
}

const qs = (params = {}) => {
  const s = new URLSearchParams(
    Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== '')
  ).toString();
  return s ? `?${s}` : '';
};

export const api = {
  get:   (path, params) => request('GET', path + qs(params)),
  post:  (path, body)   => request('POST', path, body ?? {}),
  patch: (path, body)   => request('PATCH', path, body ?? {}),
  put:   (path, body)   => request('PUT', path, body ?? {}),
  del:   (path)         => request('DELETE', path),

  leads: {
    list:    (params)     => request('GET', '/api/leads' + qs(params)),
    stats:   ()           => request('GET', '/api/leads/stats'),
    get:     (id)         => request('GET', `/api/leads/${id}`),
    create:  (body)       => request('POST', '/api/leads', body),
    update:  (id, body)   => request('PATCH', `/api/leads/${id}`, body),
    remove:  (id)         => request('DELETE', `/api/leads/${id}`),
    bulkStatus: (ids, status) => request('POST', '/api/leads/bulk-status', { ids, status }),
    bulkDelete: (body)        => request('POST', '/api/leads/bulk-delete', body),
    assign:     (id, userId)  => request('PATCH', `/api/leads/${id}`, { assigned_to: userId }),
    bulkAssign: (ids, userId) => request('POST', '/api/leads/bulk-assign', { ids, assigned_to: userId }),
  },
  templates: {
    list:   ()          => request('GET', '/api/templates'),
    create: (body)      => request('POST', '/api/templates', body),
    update: (id, body)  => request('PUT', `/api/templates/${id}`, body),
    remove: (id)        => request('DELETE', `/api/templates/${id}`),
    starters: ()        => request('POST', '/api/templates/starters', {}),
    render: (id, leadId) =>
      request('GET', `/api/templates/${id}/render${qs({ lead_id: leadId })}`),
  },
  emails: {
    preview: (leadId, templateId) =>
      request('GET', `/api/emails/preview${qs({ lead_id: leadId, template_id: templateId })}`),
    log:     (body)   => request('POST', '/api/emails/log', body),
    history: (params) => request('GET', '/api/emails/log' + qs(params)),
  },
  settings: {
    get:  ()     => request('GET', '/api/settings'),
    save: (body) => request('PUT', '/api/settings', body),
  },
  contacts: {
    signals: (leadId)       => request('GET',  `/api/leads/${leadId}/signals`),
    find:    (leadId, opts) => request('POST', `/api/leads/${leadId}/find-contacts`, opts ?? {}),
    promote: (leadId, sid)  => request('POST', `/api/leads/${leadId}/signals/${sid}/promote`, {}),
    remove:  (leadId, sid)  => request('DELETE',`/api/leads/${leadId}/signals/${sid}`),
  },
  outreach: {
    prepare: (body)    => request('POST', '/api/outreach/prepare', body),
    sent:    (eventId) => request('POST', `/api/outreach/${eventId}/sent`, {}),
    list:    (params)  => request('GET',  '/api/outreach' + qs(params)),
  },
  invoices: {
    list:     (params)     => request('GET',  '/api/invoices' + qs(params)),
    get:      (id)         => request('GET',  `/api/invoices/${id}`),
    create:   (body)       => request('POST', '/api/invoices', body),
    sent:     (id)         => request('POST', `/api/invoices/${id}/sent`, {}),
    paid:     (id, method) => request('POST', `/api/invoices/${id}/paid`, { method }),
    void:     (id)         => request('POST', `/api/invoices/${id}/void`, {}),
    remove:   (id)         => request('DELETE', `/api/invoices/${id}`),
    clients:  ()           => request('GET',  '/api/invoices/clients'),
    addClient:(body)       => request('POST', '/api/invoices/clients', body),
    plans:    ()           => request('GET',  '/api/invoices/maintenance/plans'),
    addPlan:  (body)       => request('POST', '/api/invoices/maintenance/plans', body),
    billPlan: (id)         => request('POST', `/api/invoices/maintenance/plans/${id}/bill`, {}),
    setPlan:  (id, active) => request('POST', `/api/invoices/maintenance/plans/${id}/active`, { active }),
    directDebit: (id)      => request('POST', `/api/invoices/maintenance/plans/${id}/direct-debit`, {}),
  },
  auth: {
    status:   ()             => request('GET',  '/api/auth/status'),
    me:       ()             => request('GET',  '/api/auth/me'),
    setup:    (body)         => request('POST', '/api/auth/setup', body),
    login:    (body)         => request('POST', '/api/auth/login', body),
    logout:   ()             => request('POST', '/api/auth/logout', {}),
    updateMe: (body)         => request('PATCH','/api/auth/me', body),
    roster:   ()             => request('GET',  '/api/auth/roster'),
    users:    ()             => request('GET',  '/api/auth/users'),
    addUser:  (body)         => request('POST', '/api/auth/users', body),
    setUser:  (id, body)     => request('PATCH', `/api/auth/users/${id}`, body),
  },
};
