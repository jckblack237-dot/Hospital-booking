/**
 * Clinic staff sign-in. Each clinic has its own sign-in address and nothing
 * is listed: no clinics, no staff. You reach your clinic's page by its link.
 */
import express from 'express';
import { asyncRoute, HttpError, parse } from '../lib/util.js';
import { login, logout, requireStaff, clinicBySlug, changeOwnPassword } from '../services/tenancy.js';
import { db } from '../db.js';

export const router = express.Router();

/** The one thing a sign-in page needs: this clinic's name. Demo credentials only in demo mode. */
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
