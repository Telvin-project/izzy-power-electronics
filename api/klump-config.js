module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed.' });
  }
  const publicKey = process.env.KLUMP_PUBLIC_KEY;
  if (!publicKey) {
    return res.status(503).json({ error: 'Klump is not configured yet. Add KLUMP_PUBLIC_KEY to Vercel Environment Variables and redeploy.' });
  }
  return res.status(200).json({ publicKey });
};
