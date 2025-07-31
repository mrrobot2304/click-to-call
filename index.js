// --- 1. IMPORTATIONS ET CONFIGURATION INITIALE ---
require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const twilio = require('twilio');
const cors = require('cors');
const { Client } = require('@hubspot/api-client');

const app = express();


// --- 2. MIDDLEWARES ---
// Autorise les requêtes provenant de HubSpot et de votre propre application
app.use(cors({ origin: ['https://app.hubspot.com', 'https://click-to-call-app.onrender.com'] }));
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));


// --- 3. INITIALISATION DES CLIENTS (TWILIO & HUBSPOT) ---
const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

const hubspotClient = new Client({ accessToken: process.env.HUBSPOT_API_KEY });


// --- 4. CONFIGURATION SPÉCIFIQUE À L'APPLICATION ---
// Associe les emails des employés à leur numéro de téléphone Twilio vérifié
const employeeTwilioMap = {
  "janice@glive.ca": process.env.TWILIO_PHONE_NUMBER_JANICE,
  // "autre.employe@email.com": process.env.TWILIO_PHONE_NUMBER_AUTRE
};


// --- 5. FONCTIONS HELPERS POUR HUBSPOT ---

/**
 * Trouve un contact HubSpot par son numéro de téléphone.
 * @param {string} phoneNumber Le numéro de téléphone à chercher.
 * @returns {string|null} L'ID du contact ou null.
 */
async function findContactByPhoneNumber(phoneNumber) {
  try {
    const searchRequest = {
      filterGroups: [{ filters: [{ propertyName: 'phone', operator: 'EQ', value: phoneNumber }] }],
      properties: ['id'],
      limit: 1,
    };
    const response = await hubspotClient.crm.contacts.searchApi.doSearch(searchRequest);
    if (response.results.length > 0) {
      console.log(`👤 Contact HubSpot trouvé pour ${phoneNumber}: ID ${response.results[0].id}`);
      return response.results[0].id;
    }
    console.log(`🤷 Aucun contact HubSpot trouvé pour le numéro ${phoneNumber}`);
    return null;
  } catch (error) {
    console.error("❌ Erreur lors de la recherche du contact HubSpot:", error);
    return null;
  }
}

/**
 * Journalise un appel comme un "Engagement" dans HubSpot.
 * @param {string} contactId L'ID du contact HubSpot.
 * @param {object} callData Les données de l'appel fournies par Twilio.
 */
async function logCallInHubspot(contactId, callData) {
  if (!contactId) {
    console.log("🚫 ID de contact manquant, impossible de journaliser l'appel.");
    return;
  }

  try {
    const callDirection = callData.Direction.includes('inbound') ? 'entrant' : 'sortant';
    const bodyContent = `
      Détails de l'appel Twilio :<br>
      - **Direction** : ${callDirection.charAt(0).toUpperCase() + callDirection.slice(1)}<br>
      - **Depuis** : ${callData.From}<br>
      - **Vers** : ${callData.To}<br>
      - **Durée** : ${callData.CallDuration || '0'} secondes<br>
      - **Statut** : ${callData.CallStatus}<br>
      ${callData.RecordingUrl ? `- **Enregistrement** : <a href="${callData.RecordingUrl}.mp3" target="_blank">Écouter</a>` : ''}
    `.trim();

    const engagementBody = {
      engagement: { type: 'CALL' },
      associations: { contactIds: [contactId] },
      metadata: {
        body: bodyContent,
        status: 'COMPLETED',
        durationMilliseconds: parseInt(callData.CallDuration || '0', 10) * 1000,
        fromNumber: callData.From,
        toNumber: callData.To,
        callDirection: callData.Direction.toUpperCase(),
      },
    };

    const response = await hubspotClient.crm.objects.engagements.create(engagementBody);
    console.log(`✅ Appel journalisé sur HubSpot pour le contact ${contactId}. Engagement ID: ${response.id}`);
  } catch (error) {
    console.error("❌ Erreur lors de la journalisation de l'appel sur HubSpot:", error.body || error);
  }
}


// --- 6. ROUTES DE L'API ---

/**
 * Route de "santé" pour les services de monitoring et pour garder le serveur éveillé.
 */
app.get('/ping', (req, res) => {
  console.log(`Ping received at ${new Date().toISOString()}. Pong!`);
  res.status(200).send('pong');
});

/**
 * Génère un Token d'accès Twilio pour l'extension Chrome.
 */
app.get('/token', (req, res) => {
  const email = req.query.email?.toLowerCase();
  if (!email || !employeeTwilioMap[email]) {
    return res.status(403).json({ error: "Utilisateur non autorisé ou email manquant." });
  }

  const { AccessToken } = twilio.jwt;
  const { VoiceGrant } = AccessToken;

  const token = new AccessToken(
    process.env.TWILIO_ACCOUNT_SID,
    process.env.TWILIO_API_KEY_SID,
    process.env.TWILIO_API_KEY_SECRET,
    { identity: email }
  );

  const voiceGrant = new VoiceGrant({
    outgoingApplicationSid: process.env.TWIML_APP_SID,
    incomingAllow: true,
  });
  token.addGrant(voiceGrant);

  res.json({ token: token.toJwt() });
});

/**
 * Endpoint principal qui génère le TwiML pour les appels entrants et sortants.
 */
app.post('/voice', (req, res) => {
  const { From, To, contactId } = req.body;
  console.log("📞 /voice endpoint hit. Body:", req.body);

  const twiml = new twilio.twiml.VoiceResponse();
  const serverUrl = `https://${req.get('host')}`;

  const isOutgoingFromBrowser = From?.startsWith('client:') || contactId;

  if (isOutgoingFromBrowser) {
    console.log("✅ Détecté comme un appel sortant depuis le navigateur.");
    const identity = From.startsWith('client:') ? From.replace('client:', '').toLowerCase() : Object.keys(employeeTwilioMap).find(key => employeeTwilioMap[key] === To);

    const dialOptions = {
      callerId: employeeTwilioMap[identity],
      record: 'record-from-answer-dual',
      statusCallback: `${serverUrl}/call-status`,
      statusCallbackEvent: ['completed'],
      statusCallbackMethod: 'POST',
    };

    if (contactId) {
      dialOptions.statusCallback += `?contactId=${contactId}`;
    }

    const dial = twiml.dial(dialOptions);
    dial.number(To);
    console.log(`🔄 Appel sortant vers ${To} avec callback vers ${dialOptions.statusCallback}`);

  } else { // Appel entrant standard
    console.log("📥 Détecté comme un appel entrant standard.");
    const employeeEntry = Object.entries(employeeTwilioMap).find(([_, num]) => num === To);
    
    if (employeeEntry) {
      const targetIdentity = employeeEntry[0];
      twiml.dial().client(targetIdentity);
      console.log(`📥 Appel entrant de ${From} redirigé vers l'employé ${targetIdentity}`);
    } else {
      twiml.say({ language: 'fr-FR' }, 'Personne n\'est disponible pour prendre cet appel.');
    }
  }

  res.type('text/xml');
  res.send(twiml.toString());
});


/**
 * Reçoit le statut final de l'appel de Twilio et déclenche la journalisation HubSpot.
 */
app.post('/call-status', async (req, res) => {
  const callData = req.body;
  console.log('🏁 Appel terminé, statut reçu:', callData.CallStatus);
  console.log('DEBUG: Query parameters reçus sur /call-status:', req.query);
  
  let contactId = req.query.contactId;

  if (!contactId && callData.Direction.includes('inbound')) {
    const customerNumber = callData.From;
    contactId = await findContactByPhoneNumber(customerNumber);
  }

  await logCallInHubspot(contactId, callData);

  res.sendStatus(200);
});


// --- 7. DÉMARRAGE DU SERVEUR ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Serveur en écoute sur le port ${PORT}`);
});