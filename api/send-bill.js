// Vercel serverless function: relays the website bill form to fetch@askbillhound.com via Mailgun.
// Env vars required (Vercel > Project > Settings > Environment Variables):
//   MAILGUN_API_KEY   - Mailgun private API key (or a domain sending key for askbillhound.com)
//   MAILGUN_DOMAIN    - askbillhound.com
//   BILL_INBOX        - fetch@askbillhound.com

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { name, email, phone, sms_consent, message, attachment, company } = req.body || {};

    // Honeypot: bots fill hidden fields. Pretend success, send nothing.
    if (company) return res.status(200).json({ ok: true });

    if (!name || !email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: 'Missing or invalid fields' });
    }

    const clean = (s, max) => String(s || '').slice(0, max);
    const safeName = clean(name, 60);
    const safeMsg = clean(message, 1200);

    const form = new FormData();
    form.append('from', `Billhound Website <postmaster@${process.env.MAILGUN_DOMAIN}>`);
    form.append('to', process.env.BILL_INBOX);
    form.append('h:Reply-To', `${safeName} <${email}>`);
    form.append('subject', `New bill from ${safeName}`);
    const safePhone = clean(phone, 20).replace(/[^\d+()\-. ]/g, '');
    form.append(
      'text',
      `Name: ${safeName}\nEmail: ${email}\nPhone: ${safePhone || '(not given)'}\nSMS consent: ${sms_consent ? 'YES, opted in via web form ' + new Date().toISOString() : 'no'}\n\nMessage:\n${safeMsg || '(none)'}\n\nAttachment: ${attachment ? attachment.name : 'none'}\nSource: askbillhound.com form`
    );

    if (attachment && attachment.data && attachment.name) {
      const buf = Buffer.from(attachment.data, 'base64');
      if (buf.length > 5 * 1024 * 1024) {
        return res.status(400).json({ error: 'Attachment too large' });
      }
      const type = attachment.type === 'application/pdf' ? 'application/pdf' : 'image/jpeg';
      form.append(
        'attachment',
        new Blob([buf], { type }),
        clean(attachment.name, 100).replace(/[^\w.\-]/g, '_')
      );
    }

    const mgRes = await fetch(
      `https://api.mailgun.net/v3/${process.env.MAILGUN_DOMAIN}/messages`,
      {
        method: 'POST',
        headers: {
          Authorization:
            'Basic ' + Buffer.from(`api:${process.env.MAILGUN_API_KEY}`).toString('base64'),
        },
        body: form,
      }
    );

    if (!mgRes.ok) {
      const detail = await mgRes.text();
      console.error('Mailgun error:', mgRes.status, detail);
      return res.status(502).json({ error: 'Mail relay failed' });
    }

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Server error' });
  }
}

export const config = {
  api: {
    bodyParser: {
      sizeLimit: '4.5mb',
    },
  },
};
