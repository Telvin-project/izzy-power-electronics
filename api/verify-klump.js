module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ verified: false, error: 'Method not allowed.' });
  }
  const secretKey = process.env.KLUMP_SECRET_KEY;
  if (!secretKey) {
    return res.status(503).json({ verified: false, error: 'Klump verification is not configured. Add KLUMP_SECRET_KEY to Vercel Environment Variables and redeploy.' });
  }
  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (_) { body = null; }
  }
  const reference = String(body?.reference || '').trim();
  const expectedAmount = Number(body?.expectedAmount);
  const merchantReference = String(body?.merchantReference || '').trim();
  if (!reference || reference.length > 200 || !Number.isFinite(expectedAmount) || expectedAmount <= 0) {
    return res.status(400).json({ verified: false, error: 'A valid transaction reference and expected amount are required.' });
  }
  try {
    const upstream = await fetch('https://api.useklump.com/v1/transactions/' + encodeURIComponent(reference) + '/verify', {
      method: 'GET',
      headers: { 'Content-Type': 'application/json', 'klump-secret-key': secretKey },
      signal: AbortSignal.timeout(12000)
    });
    const result = await upstream.json().catch(() => ({}));
    if (!upstream.ok) {
      console.error('Klump verification API returned HTTP', upstream.status);
      return res.status(upstream.status >= 500 ? 502 : 400).json({
        verified: false,
        error: upstream.status === 401 || upstream.status === 403
          ? 'Klump rejected the secret key. Check that KLUMP_SECRET_KEY matches the selected TEST or LIVE environment.'
          : 'Klump could not verify this transaction. Check the transaction reference and try again.'
      });
    }
    const tx = result?.data || result?.transaction || result;
    const status = String(tx?.status || tx?.transaction_status || result?.status || '').toLowerCase();
    const amount = Number(tx?.amount ?? tx?.transaction_amount ?? tx?.total_amount);
    const currency = String(tx?.currency || tx?.transaction_currency || '').toUpperCase();
    const returnedMerchantRef = String(tx?.merchant_reference || tx?.merchantReference || tx?.reference_code || '');
    const success = ['success', 'successful', 'paid', 'completed', 'complete'].includes(status);
    if (!success) {
      return res.status(200).json({ verified: false, error: 'Klump has not confirmed this transaction as successful.', status: status || 'unknown' });
    }
    if (!Number.isFinite(amount) || Math.round(amount) !== Math.round(expectedAmount)) {
      return res.status(200).json({ verified: false, error: 'The verified transaction amount does not match this order.' });
    }
    if (currency && currency !== 'NGN') {
      return res.status(200).json({ verified: false, error: 'The verified transaction currency does not match NGN.' });
    }
    if (merchantReference && returnedMerchantRef && returnedMerchantRef !== merchantReference) {
      return res.status(200).json({ verified: false, error: 'The transaction reference does not match this order.' });
    }
    return res.status(200).json({
      verified: true,
      reference,
      amount,
      currency: currency || 'NGN',
      isLive: typeof tx?.is_live === 'boolean' ? tx.is_live : null
    });
  } catch (error) {
    console.error('Klump verification request failed:', error?.name || 'Error');
    return res.status(502).json({ verified: false, error: 'Could not reach Klump to verify the transaction. Please try again shortly.' });
  }
};
