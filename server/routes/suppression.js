import { Router } from 'express';
import { wrap, notFound, str } from '../lib/http.js';
import { list, unsuppress, suppress, count } from '../lib/suppression.js';
import { looksLikeEmail } from '../lib/http.js';
import { badRequest } from '../lib/http.js';

const router = Router();

router.get('/', wrap((_req, res) => {
  res.json({ entries: list(), total: count() });
}));

/** Add an address by hand — e.g. someone who asked you to stop by phone. */
router.post('/', wrap((req, res) => {
  const email = str(req.body.email);
  if (!looksLikeEmail(email ?? '')) throw badRequest('A valid email address is required');
  suppress(email, {
    businessName: str(req.body.business_name),
    reason: str(req.body.reason) ?? 'added by hand',
  });
  res.status(201).json({ entries: list(), total: count() });
}));

/** Lift a suppression. Only ever do this if the person has asked you to. */
router.delete('/:email', wrap((req, res) => {
  if (!unsuppress(decodeURIComponent(req.params.email))) throw notFound('Not on the suppression list');
  res.status(204).end();
}));

export default router;
