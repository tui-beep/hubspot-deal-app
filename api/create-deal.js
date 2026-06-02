export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const {
    dealname, deal_type, region, lead_source, client_type,
    client_email, client_name, company_name,
    proposal_final_due_date, proposal_target_due_date, description,
    email_subject, email_body,
    pipeline_id, stage_id, owner_id, priority, delivery_method,
    _hubspot
  } = req.body || {};

  if (!dealname) return res.status(400).json({ error: 'Deal name is required' });
  if (!pipeline_id || !stage_id || !owner_id) return res.status(400).json({ error: 'Pipeline, stage, and owner are required' });

  const token = process.env.HUBSPOT_TOKEN;
  if (!token) return res.status(500).json({ error: 'HUBSPOT_TOKEN not set' });
  const hsHeaders = { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` };
  const pn = _hubspot?.property_names || {};

  const result = { contactFound: false, contactCreated: false, companyFound: false, companyCreated: false, emailCreated: false };

  try {
    let contactId = null;
    let companyId = null;
    let isExistingClient = false;

    if (client_email) {
      const searchRes = await fetch('https://api.hubapi.com/crm/v3/objects/contacts/search', {
        method: 'POST', headers: hsHeaders,
        body: JSON.stringify({
          filterGroups: [{ filters: [{ propertyName: 'email', operator: 'EQ', value: client_email }] }],
          properties: ['email', 'firstname', 'lastname'], limit: 1
        })
      });
      if (searchRes.ok) {
        const sd = await searchRes.json();
        if (sd.results?.length > 0) {
          contactId = sd.results[0].id;
          isExistingClient = true;
          result.contactFound = true;
          const assocRes = await fetch(`https://api.hubapi.com/crm/v4/objects/contacts/${contactId}/associations/companies`, { headers: hsHeaders });
          if (assocRes.ok) {
            const ad = await assocRes.json();
            if (ad.results?.length > 0) { companyId = ad.results[0].toObjectId; result.companyFound = true; }
          }
        }
      }

      if (!contactId) {
        const nameParts = (client_name || '').trim().split(/\s+/);
        const cRes = await fetch('https://api.hubapi.com/crm/v3/objects/contacts', {
          method: 'POST', headers: hsHeaders,
          body: JSON.stringify({ properties: { email: client_email, firstname: nameParts[0] || '', lastname: nameParts.slice(1).join(' ') || '' } })
        });
        if (cRes.ok) { contactId = (await cRes.json()).id; result.contactCreated = true; }
        else { const err = await cRes.json(); return res.status(500).json({ error: 'Contact creation failed: ' + (err.message || 'unknown') }); }
      }

      if (!companyId && company_name) {
        const searchCoRes = await fetch('https://api.hubapi.com/crm/v3/objects/companies/search', {
          method: 'POST', headers: hsHeaders,
          body: JSON.stringify({
            filterGroups: [{ filters: [{ propertyName: 'name', operator: 'EQ', value: company_name }] }],
            properties: ['name'], limit: 1
          })
        });
        if (searchCoRes.ok) {
          const scd = await searchCoRes.json();
          if (scd.results?.length > 0) { companyId = scd.results[0].id; result.companyFound = true; }
        }
        if (!companyId) {
          const coRes = await fetch('https://api.hubapi.com/crm/v3/objects/companies', {
            method: 'POST', headers: hsHeaders,
            body: JSON.stringify({ properties: { name: company_name } })
          });
          if (coRes.ok) { companyId = (await coRes.json()).id; result.companyCreated = true; }
          else { const err = await coRes.json(); result.companyError = err.message || 'Company creation failed'; }
        }
        if (companyId && contactId) {
          await fetch(`https://api.hubapi.com/crm/v4/objects/contacts/${contactId}/associations/default/companies/${companyId}`, { method: 'PUT', headers: hsHeaders });
        }
      }
    }

    const properties = {
      dealname,
      pipeline: pipeline_id,
      dealstage: stage_id,
      hubspot_owner_id: owner_id
    };
    if (pn.priority && priority) properties[pn.priority] = priority;
    if (pn.delivery_method && delivery_method) properties[pn.delivery_method] = delivery_method;
    if (pn.deal_type && deal_type) properties[pn.deal_type] = deal_type;
    if (pn.region && region) properties[pn.region] = region;
    if (pn.lead_source && lead_source) properties[pn.lead_source] = lead_source;
    if (pn.client_type && client_type) properties[pn.client_type] = client_type;
    if (pn.final_due_date && proposal_final_due_date) properties[pn.final_due_date] = new Date(proposal_final_due_date).getTime().toString();
    if (pn.target_due_date && proposal_target_due_date) properties[pn.target_due_date] = new Date(proposal_target_due_date).getTime().toString();
    if (description) properties.description = description;
    if (pn.client_status) {
      const csValue = isExistingClient ? _hubspot.client_status_existing : _hubspot.client_status_new;
      if (csValue) properties[pn.client_status] = csValue;
    }

    const dealRes = await fetch('https://api.hubapi.com/crm/v3/objects/deals', {
      method: 'POST', headers: hsHeaders,
      body: JSON.stringify({ properties })
    });
    const dealData = await dealRes.json();
    if (!dealRes.ok) return res.status(500).json({ error: dealData.message || 'Deal creation failed', details: dealData });
    const dealId = dealData.id;

    if (contactId) await fetch(`https://api.hubapi.com/crm/v4/objects/deals/${dealId}/associations/default/contacts/${contactId}`, { method: 'PUT', headers: hsHeaders });
    if (companyId) await fetch(`https://api.hubapi.com/crm/v4/objects/deals/${dealId}/associations/default/companies/${companyId}`, { method: 'PUT', headers: hsHeaders });

    if (email_subject && email_body) {
      const nameParts = (client_name || '').trim().split(/\s+/);
      const engagement = {
        engagement: { active: true, type: 'EMAIL', timestamp: Date.now(), ownerId: parseInt(owner_id) },
        associations: {
          contactIds: contactId ? [parseInt(contactId)] : [],
          companyIds: companyId ? [parseInt(companyId)] : [],
          dealIds: [parseInt(dealId)]
        },
        metadata: {
          subject: email_subject,
          text: email_body,
          html: email_body.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>'),
          ...(client_email && { from: { email: client_email, firstName: nameParts[0] || '', lastName: nameParts.slice(1).join(' ') || '' } })
        }
      };
      const emailRes = await fetch('https://api.hubapi.com/engagements/v1/engagements', {
        method: 'POST', headers: hsHeaders,
        body: JSON.stringify(engagement)
      });
      if (emailRes.ok) result.emailCreated = true;
      else { const err = await emailRes.json(); result.emailError = err.message || 'Email logging failed'; }
    }

    return res.status(200).json({ success: true, id: dealId, ...result });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
