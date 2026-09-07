/**
 * Public, unauthenticated routes used by the marketing site.
 *
 * The showcase is an ANONYMISED live snapshot of the demo clinic's queue —
 * token codes, states and predicted windows, never a name — and it only
 * exists while the server runs in demo mode. Nothing here touches a real
 * clinic's data.
 */
import express from 'express';
import { db } from '../db.js';
import { now } from '../lib/clock.js';
import { hhmm, mvStartOfDay } from '../lib/mvtime.js';
import { id, asyncRoute, HttpError } from '../lib/util.js';
import { readProjection } from '../engine/engine.js';

export const router = express.Router();

router.get('/showcase', asyncRoute((req, res) => {
  if (process.env.VAGUTHU_DEMO === 'false') throw HttpError.notFound('Showcase');
  const clinic = db.prepare('SELECT id, name FROM clinics ORDER BY rowid LIMIT 1').get();
  if (!clinic) throw HttpError.notFound('Showcase');
  const day = mvStartOfDay(now());
  const sessions = db.prepare(`SELECT s.id, s.state, d.name, d.specialty FROM sessions s JOIN doctors d ON d.id = s.doctor_id
                               WHERE s.clinic_id = ? AND s.scheduled_start >= ? AND s.scheduled_start < ?
                               ORDER BY s.scheduled_start, d.rowid LIMIT 4`).all(clinic.id, day, day + 86_400_000);
  res.set('Cache-Control', 'public, max-age=4');
  res.json({
    clinic: clinic.name,
    clock: hhmm(now()),
    live: sessions.some((s) => s.state === 'running'),
    sessions: sessions.map((s) => {
      const p = readProjection(s.id);
      return {
        doctor: s.name.replace(/^Dr\.?\s*/, 'Dr ').split(' ').slice(0, 2).join(' '),
        specialty: s.specialty.replace('_', ' '),
        state: s.state,
        lateMinutes: p?.runningLateMinutes ?? 0,
        nowServing: p?.nowServing ? { display: p.nowServing.display, minutes: p.nowServing.elapsedMinutes } : null,
        waiting: p?.tokensWaiting ?? 0,
        next: (p?.entries ?? []).slice(0, 4).map((e) => ({
          display: e.display, state: e.state,
          window: `${hhmm(e.predictedStart.window.from)}–${hhmm(e.predictedStart.window.to)}`,
          ahead: e.tokensAhead, leaveNow: e.leaveNow,
        })),
      };
    }),
  });
}));

router.post('/leads', express.json(), asyncRoute((req, res) => {
  const { clinic, name, contact, island, doctors, message } = req.body || {};
  if (!name || !contact) throw HttpError.badRequest('name and contact are required');
  db.prepare('INSERT INTO leads (id, clinic, name, contact, island, doctors, message, created_at) VALUES (?,?,?,?,?,?,?,?)')
    .run(id('lead'), String(clinic || '').slice(0, 120), String(name).slice(0, 120), String(contact).slice(0, 160),
      String(island || '').slice(0, 80), Number(doctors) || null, String(message || '').slice(0, 1000), Date.now());
  res.status(201).json({ ok: true });
}));
