/** Clinic staff sign-in. Each clinic is its own CRM; this is the front door. */
import express from 'express';
import { asyncRoute, HttpError } from '../lib/util.js';
import { login, logout, requireStaff, clinicsForLogin, staffForClinic } from '../services/tenancy.js';

export const router = express.Router();

/** Clinic names are public (the patient app lists them); staff lists are per clinic. */
router.get('/clinics', asyncRoute((req, res) => {
  res.json({ clinics: clinicsForLogin() });
}));

router.get('/clinics/:id/staff', asyncRoute((req, res) => {
  res.json({ staff: staffForClinic(req.params.id) });
}));

router.post('/login', asyncRoute((req, res) => {
  const { clinicId, staffId, pin } = req.body || {};
  if (!clinicId || !staffId) throw HttpError.badRequest('clinicId and staffId are required');
  res.json(login({ clinicId, staffId, pin }));
}));

router.post('/logout', requireStaff, asyncRoute((req, res) => {
  logout(req.tenant.token);
  res.status(204).end();
}));

router.get('/me', requireStaff, asyncRoute((req, res) => {
  res.json({ staff: req.tenant.staff, clinicId: req.tenant.clinicId });
}));
