/**
 * Clinic staff sign-in. One form: username and password. The clinic follows
 * from the account. Nothing is listed — no clinics, no staff — except the
 * seeded demo sign-ins, and those only in demo mode.
 */
import express from 'express';
import { asyncRoute, HttpError, parse } from '../lib/util.js';
import { login, logout, requireStaff, clinicBySlug, changeOwnPassword, demoCredentials } from '../services/tenancy.js';
import { db } from '../db.js';

export const router = express.Router();

/** The sign-in page needs nothing. In demo mode it may show the seeded sign-ins. */
router.get('/sign-in', asyncRoute((req, res) => {
  res.json({ demo: demoCredentials() });
}));

router.post('/login', asyncRoute((req, res) => {
  const { username, password } = req.body || {};
  res.json(login({ username, password, ip: req.ip }));
}));

/** Optional: a clinic's own address, which shows its name and accepts only its accounts. */
router.get('/clinic/:slug', asyncRoute((req, res) => {
  const clinic = clinicBySlug(req.params.slug);
  if (!clinic) throw HttpError.notFound('Clinic');
  const out = { name: clinic.name, island: clinic.island, atoll: clinic.atoll, slug: clinic.slug };
  if (process.env.VAGUTHU_DEMO !== 'false') {
    const settings = parse(clinic.settings, {}) || {};
    if (settings.demoCredentials) out.demo = settings.demoCredentials;
  }
  res.json(out);
}));

router.post('/clinic/:slug/login', asyncRoute((req, res) => {
  const { username, password } = req.body || {};
  res.json(login({ slug: req.params.slug, username, password, ip: req.ip }));
}));

router.post('/logout', requireStaff, asyncRoute((req, res) => {
  logout(req.tenant.token);
  res.status(204).end();
}));

router.get('/me', requireStaff, asyncRoute((req, res) => {
  const clinic = db.prepare('SELECT id, name, island, atoll, slug FROM clinics WHERE id = ?').get(req.tenant.clinicId);
  res.json({ staff: req.tenant.staff, clinic });
}));

router.post('/change-password', requireStaff, asyncRoute((req, res) => {
  changeOwnPassword(req.tenant.staff.id, req.body?.currentPassword, req.body?.newPassword);
  res.json({ ok: true });
}));
