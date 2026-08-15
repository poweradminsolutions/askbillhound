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
    const { name, full_name, business_name, vendor_name, email, phone, sms_consent, message, attachment, attachments, pdf_meta, company, source } = req.body || {};

    // Honeypot: pretend success, deliver nothing.
    if (company) return res.status(200).json({ ok: true });

    if (!name || !email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: 'Missing or invalid fields' });
    }

    const clean = (s, max) => String(s || '').slice(0, max);

    // Validate attachments (array of page images; legacy single 'attachment' still accepted)
    const rawList = Array.isArray(attachments) ? attachments : (attachment ? [attachment] : []);
    const attList = [];
    let totalBytes = 0;
    for (const a of rawList.slice(0, 10)) {
      if (!a || !a.data || !a.name) continue;
      const buf = Buffer.from(a.data, 'base64');
      totalBytes += buf.length;
      if (buf.length > 5 * 1024 * 1024 || totalBytes > 8 * 1024 * 1024) {
        return res.status(400).json({ error: 'Attachments too large' });
      }
      attList.push({
        filename: clean(a.name, 100).replace(/[^\w.\-]/g, '_'),
        content_type: a.type === 'application/pdf' ? 'application/pdf' : 'image/jpeg',
        data_base64: a.data,
        size_bytes: buf.length,
      });
    }

    const payload = {
      event: 'billhound_form_submission',
      submission_id: randomUUID(),
      received_at: new Date().toISOString(),
      source: ['cardshield_page', 'business_page'].includes(source) ? source : 'web_form',
      customer: {
        first_name: clean(name, 60),
        // Business leads submit one "Your name" field, so the full name lands
        // here and first_name may hold both words. Null on consumer leads.
        full_name: full_name ? clean(full_name, 60) : null,
        email: clean(email, 120).toLowerCase(),
        phone: clean(phone, 20).replace(/[^\d+()\-. ]/g, ''),
        sms_consent: !!sms_consent,
        sms_consent_at: sms_consent ? new Date().toISOString() : null,
      },
      // Present only on business submissions. Maps straight to SIBT's
      // Company Name field with no string parsing needed.
      business: business_name
        ? { name: clean(business_name, 80), vendor: vendor_name ? clean(vendor_name, 80) : null }
        : null,
      message: clean(message, 1200),
      attachments: attList,
      attachment: attList[0] || null, // legacy field for receiver compatibility
      pdf_meta: pdf_meta && typeof pdf_meta === 'object' ? { total_pages: Number(pdf_meta.total_pages) || null, truncated: !!pdf_meta.truncated } : null,
    };

    // ---- Webhook chain: Randy primary, Fred secondary. Same payload contract. ----
    async function tryWebhook(url, label) {
      if (!url) return false;
      try {
        const controller = new AbortController();
        const t = setTimeout(() => controller.abort(), 8000);
        const r = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
          signal: controller.signal,
        });
        clearTimeout(t);
        if (r.ok) return true;
        console.error(label + ' webhook non-OK:', r.status);
        return false;
      } catch (err) {
        console.error(label + ' webhook unreachable:', err.message);
        return false;
      }
    }

    if (await tryWebhook(process.env.RANDY_WEBHOOK_URL, 'Randy')) {
      return res.status(200).json({ ok: true, submission_id: payload.submission_id });
    }
    if (await tryWebhook(process.env.FRED_WEBHOOK_URL, 'Fred')) {
      return res.status(200).json({ ok: true, via: 'fallback', submission_id: payload.submission_id });
    }

    // ---- Fallback: Mailgun email to BILL_INBOX ----
    const form = new FormData();
    form.append('from', `Billhound Website <postmaster@${process.env.MAILGUN_DOMAIN}>`);
    form.append('to', process.env.BILL_INBOX);
    form.append('h:Reply-To', `${payload.customer.first_name} <${payload.customer.email}>`);
    form.append('subject', `[WEBHOOK-FALLBACK] New bill from ${payload.customer.first_name}`);
    form.append(
      'text',
      `Randy and Fred webhooks both unreachable; manual processing needed.\n\n` +
      `Submission: ${payload.submission_id}\nSource: ${payload.source}\n` +
      `Name: ${payload.customer.full_name || payload.customer.first_name}\nEmail: ${payload.customer.email}\n` +
      (payload.business ? `Business: ${payload.business.name}\nVendor: ${payload.business.vendor || '(not given)'}\n` : '') +
      `Phone: ${payload.customer.phone || '(not given)'}\n` +
      `SMS consent: ${payload.customer.sms_consent ? 'YES ' + payload.customer.sms_consent_at : 'no'}\n\n` +
      `Message:\n${payload.message || '(none)'}\n\nAttachments: ${attList.length ? attList.map(a => a.filename).join(', ') : 'none'}`
    );
    for (const a of attList) {
      form.append('attachment', new Blob([Buffer.from(a.data_base64, 'base64')], { type: a.content_type }), a.filename);
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
    return res.status(200).json({ ok: true, submission_id: payload.submission_id });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Server error' });
  }
}

export const config = { api: { bodyParser: { sizeLimit: '4.5mb' } } };
