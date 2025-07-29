require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const path = require('path');
const twilio = require('twilio');
const cors = require('cors');
const axios = require('axios'); // NOUVEAU: Import de axios pour les requêtes HTTP

const app = express();

// 🛡️ Middlewares
const allowedOrigins = ['https://app.hubspot.com', 'https://click-to-call-app.onrender.com', 'chrome-extension://*']; // NOUVEAU: Ajout de 'chrome-extension://*' si votre extension a un ID spécifique
app.use(cors({
  origin: function (origin, callback) {
    // Permettre les requêtes sans 'origin' (ex: requêtes directes via Postman, fichiers locaux, ou certaines extensions)
    if (!origin) return callback(null, true);

    // Vérifier si l'origine est dans la liste des origines permises
    if (allowedOrigins.includes(origin) || origin.startsWith('chrome-extension://')) { // NOUVEAU: Gérer spécifiquement les extensions
      return callback(null, true);
    } else {
      const error = new Error('CORS non autorisé : ' + origin);
      console.warn(error.message);
      return callback(error);
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

// 📒 Mapping des utilisateurs HubSpot → numéros Twilio
const employeeTwilioMap = {
  "janice@glive.ca": "+14506001665",
  // "sandra@tonentreprise.com": "+14155552672",
};

// 🔑 Constantes et fonctions pour HubSpot API (réintégration)
const HUBSPOT_API_KEY = process.env.HUBSPOT_API_KEY; // Votre clé privée d'application HubSpot
const HUBSPOT_DEFAULT_OWNER_ID = process.env.HUBSPOT_DEFAULT_OWNER_ID; // Optionnel: ID du propriétaire par défaut si non trouvé

if (!HUBSPOT_API_KEY) {
    console.error("❌ Erreur: La variable d'environnement HUBSPOT_API_KEY n'est pas définie. L'intégration HubSpot ne fonctionnera pas.");
    // Process.exit(1); // Décommenter pour arrêter le serveur si la clé est manquante
}

/**
 * Recherche un contact HubSpot par numéro de téléphone.
 * @param {string} phoneNumber Le numéro de téléphone à rechercher.
 * @returns {Promise<object|null>} Le contact HubSpot trouvé ou null.
 */
async function searchHubSpotContactByPhone(phoneNumber) {
    if (!HUBSPOT_API_KEY) {
        console.error("HUBSPOT_API_KEY non configurée. Impossible de rechercher des contacts.");
        return null;
    }
    try {
        const response = await axios.post(
            `https://api.hubapi.com/crm/v3/objects/contacts/search`,
            {
                filterGroups: [{
                    filters: [{
                        propertyName: "phone",
                        operator: "EQ",
                        value: phoneNumber
                    }]
                }],
                properties: ["firstname", "lastname", "email", "phone"],
                limit: 1 // On cherche juste un match
            },
            {
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${HUBSPOT_API_KEY}`
                }
            }
        );

        if (response.data.results && response.data.results.length > 0) {
            return response.data.results[0];
        } else {
            return null;
        }
    } catch (error) {
        console.error("❌ Erreur lors de la recherche du contact HubSpot :", error.response ? error.response.data : error.message);
        return null;
    }
}

/**
 * Crée un engagement d'appel dans HubSpot.
 * @param {object} callPayload Les données de l'appel à enregistrer.
 */
async function createHubSpotCallEngagement(callPayload) {
    if (!HUBSPOT_API_KEY) {
        console.error("HUBSPOT_API_KEY non configurée. Impossible de créer l'engagement d'appel.");
        return;
    }
    try {
        const response = await axios.post(
            `https://api.hubapi.com/crm/v3/objects/calls`,
            callPayload,
            {
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${HUBSPOT_API_KEY}`
                }
            }
        );
        console.log("✅ Appel enregistré dans HubSpot :", response.data.id);
    } catch (error) {
        console.error("❌ Erreur lors de la création de l'engagement d'appel HubSpot :", error.response ? error.response.data : error.message);
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
  // NOUVEAU: Récupérer hubspotOwnerId du frontend
  const { employeeEmail, clientPhone, hubspotOwnerId } = req.body;

  if (!employeeEmail || !clientPhone || !hubspotOwnerId) { // NOUVEAU: Vérifier la présence de hubspotOwnerId
    return res.status(400).send('Paramètres manquants : employeeEmail, clientPhone, ou hubspotOwnerId.');
  }

  const employeeTwilioNumber = employeeTwilioMap[employeeEmail.toLowerCase()];
  if (!employeeTwilioNumber) {
    return res.status(403).send('Aucun numéro Twilio associé à cet utilisateur.');
  }

  try {
    // NOUVEAU: Passer hubspotOwnerId au TWIML_BRIDGE_URL (qui pointe vers /voice)
    const twimlBridgeUrlWithParams =
        `${process.env.TWIML_BRIDGE_URL}?clientPhone=${encodeURIComponent(clientPhone)}&hubspotOwnerId=${encodeURIComponent(hubspotOwnerId)}`;

    await client.calls.create({
      to: employeeTwilioNumber, // Le client Twilio va appeler l'employé
      from: process.env.TWILIO_PHONE_NUMBER, // Votre numéro Twilio configuré comme "From" pour les appels sortants
      url: twimlBridgeUrlWithParams, // NOUVEAU: L'URL avec les paramètres
      // NOUVEAU: Pour les appels sortants, le `statusCallback` peut être utile pour suivre l'état de la jambe agent->Twilio
      // Mais le `recordingStatusCallback` du TwiML sera pour la jambe Twilio->Client
      statusCallback: `${process.env.BASE_URL}/call-status-callback?hubspotOwnerId=${encodeURIComponent(hubspotOwnerId)}`,
      statusCallbackEvent: ['answered', 'completed', 'failed', 'busy', 'no-answer'],
      statusCallbackMethod: 'POST'
    });

    res.send('Appel lancé avec succès.');
  } catch (err) {
    console.error('❌ Erreur Twilio.createCall :', err);
    res.status(500).send(err.message);
  }
});

// NOUVEAU: Endpoint pour suivre le statut de l'appel (optionnel, mais utile)
app.post('/call-status-callback', (req, res) => {
    const { CallSid, CallStatus, Direction, From, To, hubspotOwnerId } = req.body;
    console.log(`📡 Statut d'appel (${Direction}) - SID: ${CallSid}, Statut: ${CallStatus}, From: ${From}, To: ${To}, Owner: ${hubspotOwnerId}`);
    // Vous pourriez logguer ces informations ou mettre à jour un état d'appel
    res.sendStatus(200);
});


// 📞 Endpoint unique pour appels sortants et entrants
app.post('/voice', (req, res) => {
  const from = req.body.From;
  const to = req.body.To;
  // NOUVEAU: Récupérer les paramètres passés depuis /click-to-call via query string
  const clientPhoneFromQuery = req.query.clientPhone;
  const hubspotOwnerIdFromQuery = req.query.hubspotOwnerId;

  console.log("📞 Appel reçu sur /voice :", {
      body: req.body,
      query: req.query
  });

  const twiml = new twilio.twiml.VoiceResponse();
  const dialOptions = {
    record: 'record-from-answer-dual', // Enregistrement des deux côtés
    // NOUVEAU: Passer hubspotOwnerId et autres infos au recordingStatusCallback
    recordingStatusCallback: `${process.env.BASE_URL}/recording-callback?hubspotOwnerId=${encodeURIComponent(hubspotOwnerIdFromQuery || HUBSPOT_DEFAULT_OWNER_ID)}&clientPhone=${encodeURIComponent(clientPhoneFromQuery || from)}`,
    recordingStatusCallbackEvent: ['completed']
  };

  // Logique pour gérer les appels sortants initiés par le bouton "Click-to-Call"
  if (clientPhoneFromQuery && hubspotOwnerIdFromQuery) {
    // C'est un appel sortant initié par votre extension (via /click-to-call)
    // L'employé (client Twilio) a appelé votre numéro Twilio, et maintenant Twilio doit appeler le client externe.
    const employeeIdentity = from?.replace('client:', '').toLowerCase(); // L'identité de l'employé est dans 'From'
    const employeeNumber = employeeTwilioMap[employeeIdentity]; // Le numéro Twilio associé à l'employé

    if (!employeeNumber) {
        console.error("❌ Numéro Twilio de l'employé introuvable pour l'identité :", employeeIdentity);
        twiml.say("Désolé, votre numéro Twilio n'a pas pu être identifié.");
        res.type('text/xml');
        return res.status(400).send(twiml.toString());
    }
    
    // Le callerId de l'appel vers le client final doit être le numéro Twilio de l'entreprise
    // Pas le numéro de l'employé TwilioClient.
    dialOptions.callerId = process.env.TWILIO_PHONE_NUMBER; // Votre numéro Twilio pour les appels sortants
    
    const dial = twiml.dial(dialOptions);
    dial.number(clientPhoneFromQuery); // Le numéro du client à appeler

    console.log(`🔄 Appel sortant initié par ${employeeIdentity} vers client ${clientPhoneFromQuery}`);
  } else {
    // C'est un appel entrant direct vers un de vos numéros Twilio
    const calledNumber = to; // Le numéro Twilio qui a été appelé
    const employeeEntry = Object.entries(employeeTwilioMap).find(([_, num]) => num === calledNumber);

    if (!employeeEntry) {
      console.error("❌ Aucun employé trouvé pour ce numéro Twilio :", calledNumber);
      twiml.say("Désolé, aucun employé n'est configuré pour recevoir des appels sur ce numéro.");
      res.type('text/xml');
      return res.status(400).send(twiml.toString());
    }

    const targetIdentity = employeeEntry[0]; // email de l'employé (identité Twilio Client)
    // Pour les appels entrants, on peut aussi passer l'ID du propriétaire, soit par défaut, soit via un mapping
    // Pour l'instant, on utilise l'email de l'employé comme identifiant unique
    // et on le fera correspondre à un ownerId dans le recording-callback.
    // L'ID du propriétaire est ici `HUBSPOT_DEFAULT_OWNER_ID` ou doit être résolu via l'email de l'employé
    dialOptions.recordingStatusCallback = `${process.env.BASE_URL}/recording-callback?hubspotOwnerId=${encodeURIComponent(hubspotOwnerIdFromQuery || HUBSPOT_DEFAULT_OWNER_ID)}&clientPhone=${encodeURIComponent(from)}&isIncoming=true`; // Pour appels entrants, le client est 'From'

    const dial = twiml.dial(dialOptions);
    dial.client(targetIdentity);
    console.log("📥 Appel entrant redirigé vers client :", targetIdentity);
  }

  res.type('text/xml');
  res.send(twiml.toString());
});


// 📞 Endpoint pour le callback d'enregistrement Twilio
app.post('/recording-callback', async (req, res) => {
  const {
    CallSid, // CallSid de la jambe Dial (celle qui a l'enregistrement)
    RecordingSid,
    RecordingUrl,
    RecordingDuration,
    DialCallStatus, // Statut de l'appel sortant (pour les appels sortants)
    Direction, // Direction de la jambe d'appel (ex: outbound-dial, inbound)
    From, // Numéro/identité de l'appelant pour cette jambe
    To, // Numéro/identité de l'appelé pour cette jambe
  } = req.body;

  // NOUVEAU: Récupérer le hubspotOwnerId et clientPhone passés via les query parameters
  const hubspotOwnerId = req.query.hubspotOwnerId;
  let contactPhoneNumber = req.query.clientPhone;
  const isIncoming = req.query.isIncoming === 'true'; // Flag pour distinguer les appels entrants


  const recordingMp3Url = `${RecordingUrl}.mp3`;

  console.log("✅ Enregistrement et détails de l'appel reçus sur /recording-callback :", {
    CallSid,
    RecordingSid,
    RecordingDuration,
    recordingMp3Url,
    DialCallStatus,
    Direction,
    From,
    To,
    hubspotOwnerId, // L'ID du propriétaire HubSpot que nous avons passé
    contactPhoneNumber, // Le numéro de téléphone du contact final
    isIncoming,
  });

  if (!contactPhoneNumber) {
      console.error('❌ Numéro de téléphone du contact manquant pour l\'enregistrement HubSpot.');
      return res.sendStatus(200); // Répondre 200 pour éviter les retransmissions par Twilio
  }

  // 1. Déterminer la direction de l'appel pour HubSpot
  // hs_call_direction doit être 'INBOUND' ou 'OUTBOUND'
  let hsCallDirection = 'OUTBOUND'; // Par défaut pour les appels sortants initiés par l'extension
  if (isIncoming || Direction === 'inbound') {
      hsCallDirection = 'INBOUND';
  }

  // 2. Rechercher le contact HubSpot
  const hubspotContact = await searchHubSpotContactByPhone(contactPhoneNumber);
  let hubspotContactId = null;
  if (hubspotContact) {
    hubspotContactId = hubspotContact.id;
    console.log(`✅ Contact HubSpot trouvé pour ${contactPhoneNumber}: ${hubspotContact.id}`);
  } else {
    console.warn(`⚠️ Aucun contact HubSpot trouvé pour le numéro : ${contactPhoneNumber}. L'appel sera quand même enregistré mais sans association.`);
  }

  // 3. Préparer les données de l'appel pour HubSpot
  const callOutcome = {
      'completed': 'COMPLETED',
      'no-answer': 'NO_ANSWER',
      'failed': 'FAILED',
      'busy': 'BUSY',
      'canceled': 'CANCELED'
  }[DialCallStatus] || 'UNKNOWN'; // Mettre UNKNOWN si le statut n'est pas mappé

  const callProperties = {
    hs_timestamp: new Date().toISOString(),
    hs_call_duration: parseInt(RecordingDuration) * 1000, // Durée en millisecondes
    hs_call_direction: hsCallDirection,
    hs_call_outcome_type: callOutcome,
    hs_call_from_number: From, // Numéro/identité Twilio
    hs_call_to_number: To, // Numéro/identité Twilio
    hs_external_id: CallSid, // ID de l'appel Twilio (pour référence)
    hs_call_recording_url: recordingMp3Url,
    hs_call_title: `${hsCallDirection === 'INBOUND' ? 'Appel entrant' : 'Appel sortant'} - ${contactPhoneNumber}`,
    hs_call_body: `Enregistrement de l'appel : ${recordingMp3Url}`,
  };

  // NOUVEAU: Utiliser l'ID du propriétaire passé en paramètre, sinon l'ID par défaut
  if (hubspotOwnerId && hubspotOwnerId !== 'undefined') { // Vérifier aussi 'undefined' en string
      callProperties.hubspot_owner_id = hubspotOwnerId;
  } else if (HUBSPOT_DEFAULT_OWNER_ID) {
      callProperties.hubspot_owner_id = HUBSPOT_DEFAULT_OWNER_ID;
      console.warn('⚠️ Aucun ID de propriétaire HubSpot spécifique disponible. Utilisation de l\'ID par défaut.');
  } else {
      console.warn('⚠️ Aucun ID de propriétaire HubSpot disponible pour cet appel. L\'appel sera créé sans propriétaire.');
  }

  const callPayload = {
    properties: callProperties,
    associations: []
  };

  if (hubspotContactId) {
    callPayload.associations.push({
      to: { id: hubspotContactId },
      type: 'call_to_contact' // Type d'association standard
    });
  }

  // 4. Envoyer les données à HubSpot
  await createHubSpotCallEngagement(callPayload);

  res.sendStatus(200); // Toujours répondre 200 à Twilio pour accuser réception
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