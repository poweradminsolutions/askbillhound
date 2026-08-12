// Vercel serverless: pushes form submissions to Randy's webhook (primary),
// falls back to Mailgun email to BILL_INBOX if the webhook is unreachable.
// Env vars:
//   RANDY_WEBHOOK_URL  - full URL including ?token=... per SIBT super agent pattern
//   MAILGUN_API_KEY    - fallback lane
//   MAILGUN_DOMAIN     - askbillhound.com
//   BILL_INBOX         - fetch@askbillhound.com

import { randomUUID } from 'crypto';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { name, email, phone, sms_consent, message, attachment, company, source } = req.body || {};

    // Honeypot: pretend success, deliver nothing.
    if (company) return res.status(200).json({ ok: true });

    if (!name || !email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: 'Missing or invalid fields' });
    }

    const clean = (s, max) => String(s || '').slice(0, max);

    // Validate attachment early
    let att = null;
    if (attachment && attachment.data && attachment.name) {
      const buf = Buffer.from(attachment.data, 'base64');
      if (buf.length > 5 * 1024 * 1024) {
        return res.status(400).json({ error: 'Attachment too large' });
      }
      att = {
        filename: clean(attachment.name, 100).replace(/[^\w.\-]/g, '_'),
        content_type: attachment.type === 'application/pdf' ? 'application/pdf' : 'image/jpeg',
        data_base64: attachment.data,
        size_bytes: buf.length,
      };
    }

    const payload = {
      event: 'billhound_form_submission',
      submission_id: randomUUID(),
      received_at: new Date().toISOString(),
      source: source === 'cardshield_page' ? 'cardshield_page' : 'web_form',
      customer: {
        first_name: clean(name, 60),
        email: clean(email, 120).toLowerCase(),
        phone: clean(phone, 20).replace(/[^\d+()\-. ]/g, ''),
        sms_consent: !!sms_consent,
        sms_consent_at: sms_consent ? new Date().toISOString() : null,
      },
      message: clean(message, 1200),
      attachment: att, // null when none
    };

    // ---- Primary: Randy webhook ----
    if (process.env.RANDY_WEBHOOK_URL) {
      try {
        const controller = new AbortController();
        const t = setTimeout(() => controller.abort(), 8000);
        const r = await fetch(process.env.RANDY_WEBHOOK_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
          signal: controller.signal,
        });
        clearTimeout(t);
        if (r.ok) return res.status(200).json({ ok: true });
        console.error('Randy webhook non-OK:', r.status);
      } catch (err) {
        console.error('Randy webhook unreachable:', err.message);
      }
    }

    // ---- Fallback: Mailgun email to BILL_INBOX ----
    const form = new FormData();
    form.append('from', `Billhound Website <postmaster@${process.env.MAILGUN_DOMAIN}>`);
    form.append('to', process.env.BILL_INBOX);
    form.append('h:Reply-To', `${payload.customer.first_name} <${payload.customer.email}>`);
    form.append('subject', `[WEBHOOK-FALLBACK] New bill from ${payload.customer.first_name}`);
    form.append(
      'text',
      `Randy webhook was unreachable; processing needed.\n\n` +
      `Submission: ${payload.submission_id}\nSource: ${payload.source}\n` +
      `Name: ${payload.customer.first_name}\nEmail: ${payload.customer.email}\n` +
      `Phone: ${payload.customer.phone || '(not given)'}\n` +
      `SMS consent: ${payload.customer.sms_consent ? 'YES ' + payload.customer.sms_consent_at : 'no'}\n\n` +
      `Message:\n${payload.message || '(none)'}\n\nAttachment: ${att ? att.filename : 'none'}`
    );
    if (att) {
      form.append('attachment', new Blob([Buffer.from(att.data_base64, 'base64')], { type: att.content_type }), att.filename);
    }

    const mgRes = await fetch(`https://api.mailgun.net/v3/${process.env.MAILGUN_DOMAIN}/messages`, {
      method: 'POST',
      headers: { Authorization: 'Basic ' + Buffer.from(`api:${process.env.MAILGUN_API_KEY}`).toString('base64') },
      body: form,
    });
    if (!mgRes.ok) {
      console.error('Fallback mail failed:', mgRes.status, await mgRes.text());
      return res.status(502).json({ error: 'Delivery failed' });
    }
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Server error' });
  }
}

export const config = { api: { bodyParser: { sizeLimit: '4.5mb' } } };
