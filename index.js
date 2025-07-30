require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const path = require('path');
const twilio = require('twilio');
const cors = require('cors');
const axios = require('axios');
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

// 📒 Mapping des utilisateurs HubSpot → numéros Twilio
const employeeTwilioMap = {
  "janice@glive.ca": "+14506001665",
  // "sandra@tonentreprise.com": "+14155552672",
};

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

// 📞 Endpoint unique pour appels sortants et entrants
app.post('/voice', (req, res) => {
  const from = req.body.From;
  const to = req.body.To;

  console.log("📞 Appel reçu sur /voice :", req.body);

  const identity = from?.startsWith('client:') ? from.replace('client:', '').toLowerCase() : null;
  const callerId = employeeTwilioMap[identity];

  const twiml = new twilio.twiml.VoiceResponse();
  const dialOptions = {
    record: 'record-from-answer-dual',
    recordingStatusCallback: 'https://click-to-call-app.onrender.com/recording-callback',
    recordingStatusCallbackEvent: ['completed']
  };

  if (callerId && to) {
    // Appel sortant (depuis extension vers client)
    dialOptions.callerId = callerId;
    const dial = twiml.dial(dialOptions);
    dial.number(to);
    console.log("🔄 Appel sortant vers numéro :", to);
  } else {
    // Appel entrant : rediriger vers un employé Twilio Client (ex: janice@glive.ca)
    // Ici, on suppose que le numéro Twilio appelé est associé à un agent
    const calledNumber = to;
    const employeeEntry = Object.entries(employeeTwilioMap).find(([_, num]) => num === calledNumber);

    if (!employeeEntry) {
      console.error("❌ Aucun employé trouvé pour ce numéro Twilio :", calledNumber);
      return res.status(400).send('Aucun employé trouvé pour ce numéro Twilio');
    }

    const targetIdentity = employeeEntry[0]; // email ex: janice@glive.ca
    const dial = twiml.dial(dialOptions);
    dial.client(targetIdentity);
    console.log("📥 Appel entrant redirigé vers client :", targetIdentity);
  }

  res.type('text/xml');
  res.send(twiml.toString());
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

// 📝 Endpoint pour enregistrer une "Note" dans la fiche client HubSpot
app.post('/log-call', async (req, res) => {
  const { email, phoneNumber, duration, contactId, clientName } = req.body;

  if (!email || !phoneNumber || !contactId) {
    return res.status(400).json({ error: 'Champs requis manquants.' });
  }

  try {
    const engagementPayload = {
      engagement: {
        active: true,
        type: "NOTE", // ← On utilise NOTE comme fallback
        timestamp: Date.now()
      },
      associations: {
        contactIds: [parseInt(contactId)]
      },
      metadata: {
        body: `📞 Appel avec ${clientName || 'Client inconnu'} (${phoneNumber})\nDurée estimée : ${duration || 0} secondes`
      }
    };

    const response = await axios.post(
      'https://api.hubapi.com/engagements/v1/engagements',
      engagementPayload,
      {
        headers: {
          Authorization: `Bearer ${process.env.HUBSPOT_API_KEY}`,
          'Content-Type': 'application/json'
        }
      }
    );

    console.log('✅ Note créée dans HubSpot pour le contact ID', contactId);
    res.status(200).json({ success: true });
  } catch (err) {
    console.error('❌ Erreur API HubSpot (log-call) :', err.response?.data || err.message);
    res.status(500).json({ error: 'Erreur API HubSpot' });
  }
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

