/**
 * Sign in, sign out, and (for the owner) manage the team.
 *
 * This router is mounted BEFORE the gate that protects the rest of /api, so
 * every endpoint here decides its own access:
 *
 *   /status, /setup, /login   — must be reachable by someone with no session.
 *   /logout, /me              — need a session but no particular role.
 *   /users*                   — admin only.
 *
 * First run has no accounts at all, so /setup creates the first one and makes
 * it the admin. It refuses the moment any account exists, so it cannot be
 * used to mint a second admin later.
 */
import { Router } from 'express';
import { db } from '../db.js';
import { wrap, badRequest, notFound } from '../lib/http.js';
import {
  countUsers, createUser, getUserByEmail, getUserById, listUsers, teamRoster,
  setUserActive, setUserPassword, setUserPhone, verifyPassword, publicUser,
  createSession, destroySession, sessionCookie, clearCookie, isSecure,
  SESSION_COOKIE, readCookie,
} from '../lib/auth.js';

const router = Router();

function unauthorized(message) {
  const err = new Error(message);
  err.status = 401;
  return err;
}

function startSession(res, req, user) {
  const { token, expires } = createSession(user.id);
  res.setHeader('Set-Cookie', sessionCookie(token, { expires, secure: isSecure(req) }));
}

function updateName(id, name) {
  const n = String(name ?? '').trim();
  if (!n) throw badRequest('Name cannot be blank.');
  db.prepare('UPDATE users SET name = ? WHERE id = ?').run(n, id);
}

/** Where the app boots from: am I signed in, and does anyone exist yet? */
router.get('/status', wrap((req, res) => {
  res.json({
    authenticated: Boolean(req.user),
    needs_setup: countUsers() === 0,
    user: publicUser(req.user) ?? null,
  });
}));

/** Create the very first account (the admin). Only while none exist. */
router.post('/setup', wrap((req, res) => {
  if (countUsers() > 0) {
    throw badRequest('Setup is already done — ask the admin to add you.');
  }
  const user = createUser({
    email: req.body?.email,
    name: req.body?.name,
    password: req.body?.password,
    role: 'admin',
  });
  startSession(res, req, user);
  res.status(201).json({ user: publicUser(user) });
}));

router.post('/login', wrap((req, res) => {
  const email = String(req.body?.email ?? '').trim();
  const password = String(req.body?.password ?? '');
  const user = getUserByEmail(email);
  // One message for both "no such email" and "wrong password", so the form
  // cannot be used to discover which addresses have accounts. verifyPassword
  // is still run against a dummy hash when the user is missing, so the reply
  // takes about the same time either way.
  const ok = user
    ? verifyPassword(password, user.password_hash)
    : verifyPassword(password, 'scrypt$00$00');
  if (!user || !ok) throw unauthorized('That email and password do not match.');
  if (user.active !== 1) throw unauthorized('This account has been suspended.');

  startSession(res, req, user);
  res.json({ user: publicUser(user) });
}));

router.post('/logout', wrap((req, res) => {
  destroySession(readCookie(req.headers.cookie, SESSION_COOKIE));
  res.setHeader('Set-Cookie', clearCookie({ secure: isSecure(req) }));
  res.json({ ok: true });
}));

router.get('/me', wrap((req, res) => {
  if (!req.user) throw unauthorized('Not signed in.');
  res.json({ user: publicUser(req.user) });
}));

/** Anyone can change their own name, WhatsApp number and password. */
router.patch('/me', wrap((req, res) => {
  if (!req.user) throw unauthorized('Not signed in.');
  if (req.body?.name != null) updateName(req.user.id, req.body.name);
  if (req.body?.phone != null) setUserPhone(req.user.id, req.body.phone);
  if (req.body?.password != null) {
    setUserPassword(req.user.id, req.body.password);
    // setUserPassword drops every session for this user — right when an admin
    // resets someone, but here it is the user themselves, so re-issue this
    // device's session. Other devices are still signed out, which is the
    // point of changing a password.
    startSession(res, req, req.user);
  }
  res.json({ user: publicUser(getUserById(req.user.id)) });
}));

/** The team roster (id + name) — any signed-in rep, for the owner dropdowns. */
router.get('/roster', wrap((req, res) => {
  if (!req.user) throw unauthorized('Not signed in.');
  res.json({ roster: teamRoster() });
}));

/* --------------------------------------------------------------- admin */

function requireAdmin(req) {
  if (!req.user) throw unauthorized('Not signed in.');
  if (req.user.role !== 'admin') {
    const err = new Error('Only the admin can manage the team.');
    err.status = 403;
    throw err;
  }
}

router.get('/users', wrap((req, res) => {
  requireAdmin(req);
  res.json({ users: listUsers() });
}));

router.post('/users', wrap((req, res) => {
  requireAdmin(req);
  const role = req.body?.role === 'admin' ? 'admin' : 'rep';
  const user = createUser({
    email: req.body?.email, name: req.body?.name, password: req.body?.password,
    phone: req.body?.phone, role,
  });
  res.status(201).json({ user: publicUser(user) });
}));

router.patch('/users/:id', wrap((req, res) => {
  requireAdmin(req);
  const id = Number(req.params.id);
  const target = getUserById(id);
  if (!target) throw notFound('No such account.');

  // The admin must not lock or demote themselves into a hub with no admin.
  if (target.role === 'admin' && req.user.id === id
      && (req.body?.active === false || req.body?.role === 'rep')) {
    throw badRequest('You cannot suspend or demote your own admin account.');
  }

  if (req.body?.name != null) updateName(id, req.body.name);
  if (req.body?.phone != null) setUserPhone(id, req.body.phone);
  if (req.body?.active != null) setUserActive(id, Boolean(req.body.active));
  if (req.body?.password != null) setUserPassword(id, req.body.password);
  res.json({ user: publicUser(getUserById(id)) });
}));

export default router;
