import { Router } from 'express';
import { db } from '../db.js';
import { wrap, notFound, conflict, nowIso, str, requiredStr } from '../lib/http.js';
import { CANONICAL_PLACEHOLDERS, ALL_PLACEHOLDERS, unknownPlaceholders } from '../lib/template.js';

const router = Router();

router.get('/', wrap((_req, res) => {
  res.json({
    templates: db.prepare('SELECT * FROM templates ORDER BY name COLLATE NOCASE').all(),
    placeholders: CANONICAL_PLACEHOLDERS,
    all_placeholders: ALL_PLACEHOLDERS,
  });
}));

router.get('/:id', wrap((req, res) => {
  const t = db.prepare('SELECT * FROM templates WHERE id = ?').get(req.params.id);
  if (!t) throw notFound('Template not found');
  res.json({ template: t });
}));

router.post('/', wrap((req, res) => {
  const t = {
    name: requiredStr(req.body.name, 'name'),
    subject: requiredStr(req.body.subject, 'subject'),
    body: requiredStr(req.body.body, 'body'),
    created_at: nowIso(),
    updated_at: nowIso(),
  };
  try {
    const info = db.prepare(
      `INSERT INTO templates (name, subject, body, created_at, updated_at)
       VALUES (@name, @subject, @body, @created_at, @updated_at)`
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

  const t = {
    id: existing.id,
    name: str(req.body.name) ?? existing.name,
    subject: str(req.body.subject) ?? existing.subject,
    body: str(req.body.body) ?? existing.body,
    updated_at: nowIso(),
  };
  try {
    db.prepare(`UPDATE templates SET name=@name, subject=@subject, body=@body,
                updated_at=@updated_at WHERE id=@id`).run(t);
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

/** Surface typo'd placeholders rather than silently leaving them in the email. */
function warn(t) {
  const unknown = unknownPlaceholders(t.subject, t.body);
  return unknown.length
    ? [`Unrecognised placeholder(s): ${unknown.map((u) => `{{${u}}}`).join(', ')}. ` +
       `These will be left as-is in the email. Known: ${ALL_PLACEHOLDERS.map((p) => `{{${p}}}`).join(', ')}`]
    : [];
}

export default router;
