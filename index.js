require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const path = require('path');
const twilio = require('twilio');
const cors = require('cors');
const { Client } = require('@hubspot/api-client'); // ← NOUVEAU : Import du client HubSpot

const app = express();

// 🛡️ Middlewares
const allowedOrigins = ['https://app.hubspot.com', 'https://click-to-call-app.onrender.com']; // ← adapte ici
app.use(cors({
  origin: function (origin, callback) {
    if (!origin || allowedOrigins.includes(origin)) {
      return callback(null, true);
    } else {
      return callback(new Error('CORS non autorisé : ' + origin));
    }
  }
}));

app.use(bodyParser.json()); // Pour application/json
app.use(bodyParser.urlencoded({ extended: false })); // Pour x-www-form-urlencoded (Twilio)



// 🔐 Initialiser Twilio client
const client = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

// ✨ NOUVEAU : Initialiser HubSpot client
const hubspotClient = new Client({ accessToken: process.env.HUBSPOT_API_KEY });

// 📒 Mapping des utilisateurs HubSpot → numéros Twilio
const employeeTwilioMap = {
  "janice@glive.ca": "+14506001665",
  // "sandra@tonentreprise.com": "+14155552672",
};

// --- ✨ NOUVEAU : FONCTIONS HELPERS HUBSPOT ---

/**
 * Recherche un contact dans HubSpot à partir de son numéro de téléphone.
 * @param {string} phoneNumber Le numéro de téléphone du contact.
 * @returns {string|null} L'ID du contact HubSpot ou null si non trouvé.
 */
async function findContactByPhoneNumber(phoneNumber) {
  try {
    const searchRequest = {
      filterGroups: [{ filters: [{ propertyName: 'phone', operator: 'EQ', value: phoneNumber }] }],
      properties: ['firstname', 'lastname'],
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
 * Crée un engagement d'appel sur la fiche d'un contact HubSpot.
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
      ${callData.RecordingUrl ? `- **Enregistrement** : <a href="${callData.RecordingUrl}.mp3" target="_blank">Écouter l'enregistrement</a>` : ''}
    `.trim().replace(/ /g, ' ');

    const engagementBody = {
      engagement: { type: 'CALL' },
      associations: { contactIds: [contactId] },
      metadata: {
        body: bodyContent,
        status: 'COMPLETED',
        durationMilliseconds: parseInt(callData.CallDuration || '0', 10) * 1000,
        fromNumber: callData.From,
        toNumber: callData.To,
        callDirection: callDirection.toUpperCase(),
      },
    };
    
    // Si vous avez un `ownerId` (commercial assigné), vous pouvez l'ajouter ici
    // engagementBody.engagement.ownerId = 'ID_DU_PROPRIETAIRE';

    const response = await hubspotClient.crm.objects.engagements.create(engagementBody);
    console.log(`✅ Appel journalisé sur HubSpot pour le contact ${contactId}. Engagement ID: ${response.id}`);
  } catch (error) {
    console.error("❌ Erreur lors de la journalisation de l'appel sur HubSpot:", error.body || error);
  }
}

// ✅ Page d’accueil
app.get('/', (req, res) => {
  res.send('API Click-to-Call is running. Use POST /click-to-call or /token to use.');
});

// 🔐 Endpoint pour générer le token JWT Twilio Client
app.get('/token', (req, res) => {
  const email = req.query.email?.toLowerCase();
  const callerId = employeeTwilioMap[email];

  if (!callerId) {
    return res.status(403).json({ error: "Utilisateur non autorisé" });
  }

  const AccessToken = twilio.jwt.AccessToken;
  const VoiceGrant = AccessToken.VoiceGrant;

  const token = new AccessToken(
    process.env.TWILIO_ACCOUNT_SID,
    process.env.TWILIO_API_KEY,
    process.env.TWILIO_API_SECRET,
    { identity: email }
  );

  token.addGrant(new VoiceGrant({
    outgoingApplicationSid: process.env.TWIML_APP_SID,
    incomingAllow: true
  }));

  res.json({ token: token.toJwt() });
});


// 📞 Endpoint pour initier un appel Click-to-Call
app.post('/click-to-call', async (req, res) => {
  const { employeeEmail, clientPhone } = req.body;

  if (!employeeEmail || !clientPhone) {
    return res.status(400).send('Paramètres manquants.');
  }

  const employeeTwilioNumber = employeeTwilioMap[employeeEmail.toLowerCase()];
  if (!employeeTwilioNumber) {
    return res.status(403).send('Aucun numéro Twilio associé à cet utilisateur.');
  }

  try {
    await client.calls.create({
      to: employeeTwilioNumber,
      from: employeeTwilioNumber,
      url: `${process.env.TWIML_BRIDGE_URL}?clientPhone=${encodeURIComponent(clientPhone)}`
    });

    res.send('Appel lancé avec succès.');
  } catch (err) {
    console.error('❌ Erreur Twilio.createCall :', err);
    res.status(500).send(err.message);
  }
});

/**
 * 📞 MODIFIÉ : Endpoint unique pour appels
 * La logique principale est d'ajouter le `statusCallback` pour déclencher la journalisation à la fin de l'appel.
 */
/**
 * ✅ CORRIGÉ : Endpoint unique pour appels
 * La logique est améliorée pour identifier correctement les appels sortants
 * même si le 'From' n'est pas 'client:...', en se basant sur la présence du 'contactId'.
 */
app.post('/voice', (req, res) => {
  const { From, To, contactId } = req.body; // On continue de chercher le contactId ici
  console.log("📞 Appel reçu sur /voice :", req.body); // Ce log est crucial

  const twiml = new twilio.twiml.VoiceResponse();
  const serverUrl = `https://${req.get('host')}`;

  const dialOptions = {
    record: 'record-from-answer-dual',
    statusCallback: `${serverUrl}/call-status`, // L'URL de base
    statusCallbackEvent: ['completed'],
    statusCallbackMethod: 'POST'
  };

  // --- LOGIQUE CORRIGÉE ---
  // Un appel sortant est un appel initié DEPUIS le navigateur.
  // On le reconnaît s'il vient d'un 'client:' OU si un 'contactId' a été passé.
  const isOutgoingFromBrowser = From?.startsWith('client:') || contactId;

  if (isOutgoingFromBrowser) {
    console.log("✅ Détecté comme un appel sortant depuis le navigateur.");
    
    // L'identité de l'appelant est soit extraite du 'client:', soit on la recherche
    const identity = From.startsWith('client:') 
      ? From.replace('client:', '').toLowerCase()
      : Object.keys(employeeTwilioMap).find(key => employeeTwilioMap[key] === To);
      
    dialOptions.callerId = employeeTwilioMap[identity];
    
    if (contactId) {
      // On ajoute le contactId à l'URL de callback s'il existe
      dialOptions.statusCallback += `?contactId=${contactId}`;
    }
    
    const dial = twiml.dial(dialOptions);
    // Le numéro à appeler est dans 'To' pour les appels sortants via .connect()
    dial.number(To);
    console.log(`🔄 Appel sortant vers ${To} avec callback vers ${dialOptions.statusCallback}`);

  } else { // Appel entrant (un client externe appelle votre numéro Twilio)
    console.log("📥 Détecté comme un appel entrant standard.");
    const calledNumber = To;
    const employeeEntry = Object.entries(employeeTwilioMap).find(([_, num]) => num === calledNumber);

    if (!employeeEntry) {
      console.error("❌ Aucun employé trouvé pour ce numéro Twilio :", calledNumber);
      twiml.say({ language: 'fr-FR' }, 'Aucun agent disponible pour prendre cet appel.');
    } else {
      const targetIdentity = employeeEntry[0];
      const dial = twiml.dial(dialOptions); // Le callback ici n'aura pas d'ID de contact
      dial.client(targetIdentity);
      console.log(`📥 Appel entrant de ${From} redirigé vers ${targetIdentity}`);
    }
  }

  res.type('text/xml');
  res.send(twiml.toString());
});

/**
 * ✨ NOUVEAU : Endpoint pour recevoir le statut final de l'appel
 * et déclencher la journalisation dans HubSpot.
 */
app.post('/call-status', async (req, res) => {
  const callData = req.body;
  console.log('🏁 Appel terminé, statut reçu :', callData.CallStatus);
  
  // L'ID du contact peut venir du query parameter (sortant) ou on doit le chercher (entrant)
  let contactId = req.query.contactId;

  if (!contactId && callData.Direction.includes('inbound')) {
    const customerNumber = callData.From; // Le client est 'From' pour un appel entrant
    contactId = await findContactByPhoneNumber(customerNumber);
  }

  // Journalise l'appel dans HubSpot avec toutes les données
  await logCallInHubspot(contactId, callData);

  res.sendStatus(200); // Répond à Twilio que tout est OK
});


app.post('/recording-callback', (req, res) => {
  const {
    CallSid,
    RecordingSid,
    RecordingUrl,
    RecordingDuration,
  } = req.body;

  const recordingMp3Url = `${RecordingUrl}.mp3`;

  console.log("✅ Enregistrement reçu :", {
    CallSid,
    RecordingSid,
    RecordingDuration,
    recordingMp3Url,
  });

  res.sendStatus(200);
});

// Route de ping pour empêcher Render de mettre en veille l'app
app.get('/ping', (req, res) => {
  res.status(200).send('pong');
});


// 🚀 Lancer le serveur
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Serveur en écoute sur http://localhost:${PORT}`);
});

