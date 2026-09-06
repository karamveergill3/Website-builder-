import { Router } from 'express';
import { db } from '../db.js';
import { wrap, badRequest, notFound, conflict, nowIso, str, requiredStr } from '../lib/http.js';
import { CANONICAL_PLACEHOLDERS, ALL_PLACEHOLDERS, unknownPlaceholders } from '../lib/template.js';

const router = Router();

const CHANNELS = ['email', 'whatsapp', 'sms'];
const SMS_SOFT_LIMIT = 160;

function pickChannel(value, fallback = 'email') {
  const c = str(value) ?? fallback;
  if (!CHANNELS.includes(c)) {
    throw badRequest(`channel must be one of: ${CHANNELS.join(', ')}`);
  }
  return c;
}

router.get('/', wrap((req, res) => {
  const channel = req.query?.channel;
  const rows = channel
    ? db.prepare(
        'SELECT * FROM templates WHERE channel = ? ORDER BY name COLLATE NOCASE'
      ).all(String(channel))
    : db.prepare('SELECT * FROM templates ORDER BY channel, name COLLATE NOCASE').all();
  res.json({
    templates: rows,
    placeholders: CANONICAL_PLACEHOLDERS,
    all_placeholders: ALL_PLACEHOLDERS,
    channels: CHANNELS,
    sms_soft_limit: SMS_SOFT_LIMIT,
  });
}));

router.get('/:id', wrap((req, res) => {
  const t = db.prepare('SELECT * FROM templates WHERE id = ?').get(req.params.id);
  if (!t) throw notFound('Template not found');
  res.json({ template: t });
}));

router.post('/', wrap((req, res) => {
  const channel = pickChannel(req.body.channel);
  const t = {
    name: requiredStr(req.body.name, 'name'),
    // SMS and WhatsApp don't have a subject line; allow blank and store ''.
    subject: channel === 'email'
      ? requiredStr(req.body.subject, 'subject')
      : (str(req.body.subject) ?? ''),
    body: requiredStr(req.body.body, 'body'),
    channel,
    created_at: nowIso(),
    updated_at: nowIso(),
  };
  try {
    const info = db.prepare(
      `INSERT INTO templates (name, subject, body, channel, created_at, updated_at)
       VALUES (@name, @subject, @body, @channel, @created_at, @updated_at)`
    ).run(t);
    res.status(201).json({
      template: db.prepare('SELECT * FROM templates WHERE id = ?').get(info.lastInsertRowid),
      warnings: warn(t),
    });
  } catch (err) {
    if (String(err.message).includes('UNIQUE')) {
      throw conflict(`A template called "${t.name}" already exists`);
    }
    throw err;
  }
}));

router.put('/:id', wrap((req, res) => {
  const existing = db.prepare('SELECT * FROM templates WHERE id = ?').get(req.params.id);
  if (!existing) throw notFound('Template not found');

  const channel = Object.prototype.hasOwnProperty.call(req.body, 'channel')
    ? pickChannel(req.body.channel, existing.channel)
    : existing.channel;

  const t = {
    id: existing.id,
    name: str(req.body.name) ?? existing.name,
    subject: str(req.body.subject) ?? existing.subject,
    body: str(req.body.body) ?? existing.body,
    channel,
    updated_at: nowIso(),
  };
  try {
    db.prepare(`UPDATE templates SET name=@name, subject=@subject, body=@body,
                channel=@channel, updated_at=@updated_at WHERE id=@id`).run(t);
  } catch (err) {
    if (String(err.message).includes('UNIQUE')) {
      throw conflict(`A template called "${t.name}" already exists`);
    }
    throw err;
  }
  res.json({
    template: db.prepare('SELECT * FROM templates WHERE id = ?').get(existing.id),
    warnings: warn(t),
  });
}));

router.delete('/:id', wrap((req, res) => {
  const info = db.prepare('DELETE FROM templates WHERE id = ?').run(req.params.id);
  if (info.changes === 0) throw notFound('Template not found');
  res.status(204).end();
}));

/** Surface typo'd placeholders and channel-specific gotchas. */
function warn(t) {
  const w = [];
  const unknown = unknownPlaceholders(t.subject, t.body);
  if (unknown.length) {
    w.push(
      `Unrecognised placeholder(s): ${unknown.map((u) => `{{${u}}}`).join(', ')}. ` +
      `These will be left as-is. Known: ${ALL_PLACEHOLDERS.map((p) => `{{${p}}}`).join(', ')}`
    );
  }
  if (t.channel === 'sms' && String(t.body ?? '').length > SMS_SOFT_LIMIT) {
    w.push(
      `SMS bodies over ${SMS_SOFT_LIMIT} characters are split into multiple messages by carriers ` +
      `(this one is ${t.body.length}). Some carriers strip them together, some don't.`
    );
  }
  return w;
}

export default router;
