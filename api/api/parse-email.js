export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  const { email } = req.body || {};
  if (!email) {
    return res.status(400).json({ error: 'Email text is required' });
  }
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'ANTHROPIC_API_KEY is not set' });
  }

  const prompt = `Extract deal information from this client email. Return ONLY a JSON object with these fields:
- "dealname": a short descriptive name for the deal (string)
- "amount": the deal amount as a number, no currency symbols, or null if not mentioned
- "closedate": estimated close date in YYYY-MM-DD format, or null if not mentioned
- "description": a brief 1-2 sentence summary of what the deal is about

Email content:
"""
${email}
"""

Respond with valid JSON only. No extra text. No markdown code fences.`;

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1024,
        messages: [{ role: 'user', content: prompt }]
      })
    });
    const data = await response.json();
    if (!response.ok) {
      return res.status(500).json({ error: data.error?.message || 'Claude API error' });
    }
    const text = data.content?.[0]?.text || '';
    const cleaned = text.replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(cleaned);
    return res.status(200).json(parsed);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
