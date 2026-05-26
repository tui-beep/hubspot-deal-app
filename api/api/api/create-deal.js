export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  const { dealname, amount, closedate, dealstage, description } = req.body || {};
  if (!dealname) {
    return res.status(400).json({ error: 'Deal name is required' });
  }
  const token = process.env.HUBSPOT_TOKEN;
  if (!token) {
    return res.status(500).json({ error: 'HUBSPOT_TOKEN is not set' });
  }

  const properties = { dealname };
  if (amount) properties.amount = String(amount);
  if (closedate) properties.closedate = new Date(closedate).getTime().toString();
  if (dealstage) properties.dealstage = dealstage;
  if (description) properties.description = description;

  try {
    const response = await fetch('https://api.hubapi.com/crm/v3/objects/deals', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify({ properties })
    });
    const data = await response.json();
    if (!response.ok) {
      return res.status(response.status).json({ error: data.message || 'HubSpot API error' });
    }
    return res.status(200).json({ success: true, id: data.id });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
