export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const { email } = req.body || {};
  if (!email) return res.status(400).json({ error: 'Email text is required' });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  const token = process.env.HUBSPOT_TOKEN;
  if (!apiKey || !token) return res.status(500).json({ error: 'API keys not configured' });
  const hsHeaders = { 'Authorization': `Bearer ${token}` };

  try {
    const [propsRes, pipelinesRes, ownersRes] = await Promise.all([
      fetch('https://api.hubapi.com/crm/v3/properties/deals', { headers: hsHeaders }),
      fetch('https://api.hubapi.com/crm/v3/pipelines/deals', { headers: hsHeaders }),
      fetch('https://api.hubapi.com/crm/v3/owners?limit=200', { headers: hsHeaders })
    ]);

    if (!propsRes.ok) return res.status(500).json({ error: 'Failed to fetch deal properties (check scope crm.schemas.deals.read)' });
    if (!pipelinesRes.ok) return res.status(500).json({ error: 'Failed to fetch pipelines' });
    if (!ownersRes.ok) return res.status(500).json({ error: 'Failed to fetch owners (check scope crm.objects.owners.read)' });

    const propsData = await propsRes.json();
    const pipelinesData = await pipelinesRes.json();
    const ownersData = await ownersRes.json();

    const pipeline = pipelinesData.results.find(p => p.label.toLowerCase() === 'duraplan restrooms');
    if (!pipeline) return res.status(500).json({ error: 'Pipeline "Restrooms" not found in HubSpot. Available: ' + pipelinesData.results.map(p => p.label).join(', ') });
    const stage = pipeline.stages.find(s => s.label.toLowerCase() === 'triage');
    if (!stage) return res.status(500).json({ error: 'Stage "Triage" not found in Restrooms pipeline. Available: ' + pipeline.stages.map(s => s.label).join(', ') });
    const owner = ownersData.results.find(o => `${o.firstName || ''} ${o.lastName || ''}`.toLowerCase().trim() === 'sian harvey');
    if (!owner) return res.status(500).json({ error: 'Owner "Sian Harvey" not found in HubSpot owners.' });

    const findProp = (label) => propsData.results.find(p => p.label.toLowerCase() === label.toLowerCase());
    const findOptValue = (prop, label) => prop?.options?.find(o => o.label.toLowerCase() === label.toLowerCase())?.value;
    const optsAsArray = (prop) => (prop?.options || []).map(o => ({ label: o.label, value: o.value }));
    const optionLabels = (prop) => (prop?.options || []).map(o => o.label);

    const dealTypeProp = findProp('Deal type');
    const regionProp = findProp('Region');
    const leadSourceProp = findProp('Lead Source');
    const clientTypeProp = findProp('Client Type');
    const clientStatusProp = findProp('Client Status');
    const priorityProp = findProp('Priority');
    const deliveryProp = findProp('Proposal Delivery Method');
    const finalDateProp = findProp('Proposal Final Due Date');
    const targetDateProp = findProp('Proposal Target Due Date');

    const today = new Date().toISOString().split('T')[0];
    const prompt = `You are extracting structured data from a client email to populate a CRM deal form. Today is ${today}.

For each dropdown field below, pick exactly ONE option from the provided list — match labels exactly.

Email:
"""
${email}
"""

Return ONLY a JSON object:
- "dealname": short descriptive deal name
- "deal_type": one of ${JSON.stringify(optionLabels(dealTypeProp))}
- "region": one of ${JSON.stringify(optionLabels(regionProp))}
- "lead_source": one of ${JSON.stringify(optionLabels(leadSourceProp))}
- "client_type": one of ${JSON.stringify(optionLabels(clientTypeProp))}
- "client_email": main client's email address, or null
- "client_name": main client's full name, or null
- "company_name": client's company (from signature/content/email domain), or null
- "proposal_final_due_date": YYYY-MM-DD format. Use any urgency mentioned. If none, default to 14 days from today.
- "description": brief 1-2 sentence summary

JSON only. No markdown.`;

    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 1024, messages: [{ role: 'user', content: prompt }] })
    });
    const claudeData = await claudeRes.json();
    if (!claudeRes.ok) return res.status(500).json({ error: claudeData.error?.message || 'Claude API error' });
    const text = claudeData.content?.[0]?.text || '';
    const parsed = JSON.parse(text.replace(/```json|```/g, '').trim());

    const subtractBizDays = (dateStr, days) => {
      if (!dateStr) return null;
      const d = new Date(dateStr);
      if (isNaN(d.getTime())) return null;
      let r = days;
      while (r > 0) { d.setDate(d.getDate() - 1); const day = d.getDay(); if (day !== 0 && day !== 6) r--; }
      return d.toISOString().split('T')[0];
    };

    const clientStatusNew = clientStatusProp?.options?.find(o => /new|prospect/i.test(o.label))?.value;
    const clientStatusExisting = clientStatusProp?.options?.find(o => /existing|repeat|returning|active|current/i.test(o.label))?.value;

    return res.status(200).json({
      dealname: parsed.dealname,
      deal_type: findOptValue(dealTypeProp, parsed.deal_type),
      deal_type_options: optsAsArray(dealTypeProp),
      region: findOptValue(regionProp, parsed.region),
      region_options: optsAsArray(regionProp),
      lead_source: findOptValue(leadSourceProp, parsed.lead_source),
      lead_source_options: optsAsArray(leadSourceProp),
      client_type: findOptValue(clientTypeProp, parsed.client_type),
      client_type_options: optsAsArray(clientTypeProp),
      client_email: parsed.client_email,
      client_name: parsed.client_name,
      company_name: parsed.company_name,
      proposal_final_due_date: parsed.proposal_final_due_date,
      proposal_target_due_date: subtractBizDays(parsed.proposal_final_due_date, 5),
      description: parsed.description,
      _hubspot: {
        pipeline_id: pipeline.id,
        stage_id: stage.id,
        owner_id: owner.id,
        priority_value: findOptValue(priorityProp, 'Medium') || 'medium',
        delivery_method_value: findOptValue(deliveryProp, 'Email') || 'email',
        property_names: {
          deal_type: dealTypeProp?.name,
          region: regionProp?.name,
          lead_source: leadSourceProp?.name,
          client_type: clientTypeProp?.name,
          client_status: clientStatusProp?.name,
          priority: priorityProp?.name,
          delivery_method: deliveryProp?.name,
          final_due_date: finalDateProp?.name,
          target_due_date: targetDateProp?.name
        },
        client_status_new: clientStatusNew,
        client_status_existing: clientStatusExisting
      }
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
