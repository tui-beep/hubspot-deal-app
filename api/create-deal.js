export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const {
    dealname, deal_type, region, lead_source, client_type,
    client_email, client_name, company_name,
    proposal_final_due_date, proposal_target_due_date, description,
    email_subject, email_body,
    _hubspot
  } = req.body || {};

  if (!dealname) return res.status(400).json({ error: 'Deal name is required' });
  if (!_hubspot?.pipeline_id) return res.status(400).json({ error: 'Missing HubSpot metadata — re-run Parse Email first' });

  const token = process.env.HUBSPOT_TOKEN;
  if (!token) return res.status(500).json({ error: 'HUBSPOT_TOKEN not set' });
  const hsHeaders = { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` };
  const pn = _hubspot.property_names || {};

  const result = { contactFound: false, contactCreated: false, companyFound: false, companyCreated: false, emailCreated: false };

  try {
    let contactId = null;
    let companyId = null;
    let isExistingClient = false;

    if (client_email) {
      // Look up existing contact by email
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
          // Get associated company (v4)
          const assocRes = await fetch(`https://api.hubapi.com/crm/v4/objects/contacts/${contactId}/associations/companies`, { headers: hsHeaders });
          if (assocRes.ok) {
            const ad = await assocRes.json();
            if (ad.results?.length > 0) {
              companyId = ad.results[0].toObjectId;
              result.companyFound = true;
            }
          }
        }
      }

      // Create contact if not found
      if (!contactId) {
        const nameParts = (client_name || '').trim().split(/\s+/);
        const cRes = await fetch('https://api.hubapi.com/crm/v3/objects/contacts', {
          method: 'POST', headers: hsHeaders,
          body: JSON.stringify({ properties: { email: client_email, firstname: nameParts[0] || '', lastname: nameParts.slice(1).join(' ') || '' } })
        });
        if (cRes.ok) {
          contactId = (await cRes.json()).id;
          result.contactCreated = true;
        } else {
          const err = await cRes.json();
          return res.status(500).json({ error: 'Contact creation failed: ' + (err.message || 'unknown') });
        }
      }

      // Look up or create company
      if (!companyId && company_name) {
        // First check if company already exists by name
        const searchCoRes = await fetch('https://api.hubapi.com/crm/v3/objects/companies/search', {
          method: 'POST', headers: hsHeaders,
          body: JSON.stringify({
            filterGroups: [{ filters: [{ propertyName: 'name', operator: 'EQ', value: company_name }] }],
            properties: ['name'], limit: 1
          })
        });
        if (searchCoRes.ok) {
          const scd = await searchCoRes.json();
          if (scd.results?.length > 0) {
            companyId = scd.results[0].id;
            result.companyFound = true;
          }
        }
        // If still not found, create it
        if (!companyId) {
          const coRes = await fetch('https://api.hubapi.com/crm/v3/objects/companies', {
            method: 'POST', headers: hsHeaders,
            body: JSON.stringify({ properties: { name: company_name } })
          });
          if (coRes.ok) {
            companyId = (await coRes.json()).id;
            result.companyCreated = true;
          } else {
            const err = await coRes.json();
            result.companyError = err.message || 'Company creation failed';
          }
        }
        // Associate contact with company (v4)
        if (companyId && contactId) {
          await fetch(`https://api.hubapi.com/crm/v4/objects/contacts/${contactId}/associations/default/companies/${companyId}`, { method: 'PUT', headers: hsHeaders });
        }
      }
    }

    // Build deal properties
    const properties = {
      dealname,
      pipeline: _hubspot.pipeline_id,
      dealstage: _hubspot.stage_id,
      hubspot_owner_id: _hubspot.owner_id
    };
    if (pn.priority && _hubspot.priority_value) properties[pn.priority] = _hubspot.priority_value;
    if (pn.delivery_method && _hubspot.delivery_method_value) properties[pn.delivery_method] = _hubspot.delivery_method_value;
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

    // Create deal
    const dealRes = await fetch('https://api.hubapi.com/crm/v3/objects/deals', {
      method: 'POST', headers: hsHeaders,
      body: JSON.stringify({ properties })
    });
    const dealData = await dealRes.json();
    if (!dealRes.ok) return res.status(500).json({ error: dealData.message || 'Deal creation failed', details: dealData });
    const dealId = dealData.id;

    // Associate deal with contact and company (v4)
    if (contactId) await fetch(`https://api.hubapi.com/crm/v4/objects/deals/${dealId}/associations/default/contacts/${contactId}`, { method: 'PUT', headers: hsHeaders });
    if (companyId) await fetch(`https://api.hubapi.com/crm/v4/objects/deals/${dealId}/associations/default/companies/${companyId}`, { method: 'PUT', headers: hsHeaders });

    // Log email engagement in HubSpot
    if (email_subject && email_body) {
      const nameParts = (client_name || '').trim().split(/\s+/);
      const emailProps = {
        hs_email_subject: email_subject,
        hs_email_text: email_body,
        hs_email_direction: 'INCOMING_EMAIL',
        hs_email_status: 'SENT',
        hs_timestamp: Date.now().toString(),
        hubspot_owner_id: _hubspot.owner_id
      };
      if (client_email) emailProps.hs_email_from_email = client_email;
      if (nameParts[0]) emailProps.hs_email_from_firstname = nameParts[0];
      if (nameParts.slice(1).join(' ')) emailProps.hs_email_from_lastname = nameParts.slice(1).join(' ');

      const emailRes = await fetch('https://api.hubapi.com/crm/v3/objects/emails', {
        method: 'POST', headers: hsHeaders,
        body: JSON.stringify({ properties: emailProps })
      });
      if (emailRes.ok) {
        const emailId = (await emailRes.json()).id;
        result.emailCreated = true;
        if (contactId) await fetch(`https://api.hubapi.com/crm/v4/objects/emails/${emailId}/associations/default/contacts/${contactId}`, { method: 'PUT', headers: hsHeaders });
        await fetch(`https://api.hubapi.com/crm/v4/objects/emails/${emailId}/associations/default/deals/${dealId}`, { method: 'PUT', headers: hsHeaders });
        if (companyId) await fetch(`https://api.hubapi.com/crm/v4/objects/emails/${emailId}/associations/default/companies/${companyId}`, { method: 'PUT', headers: hsHeaders });
      } else {
        const err = await emailRes.json();
        result.emailError = err.message || 'Email logging failed';
      }
    }

    return res.status(200).json({ success: true, id: dealId, ...result });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
