require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const path = require('path');
const twilio = require('twilio');
const cors = require('cors');

const app = express();

// 🛡️ Middlewares
app.use(cors());
app.use(bodyParser.json()); // Pour application/json
app.use(bodyParser.urlencoded({ extended: false })); // Pour x-www-form-urlencoded (Twilio)

// 📁 Fichiers statiques
app.use(express.static(path.join(__dirname)));

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
  const email = req.query.email;
  const callerId = employeeTwilioMap[email?.toLowerCase()];

  if (!callerId) {
    return res.status(403).json({ error: "Aucun numéro Twilio associé à cet utilisateur." });
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

  console.log("🎫 Token généré pour :", email);
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

// 📞 Endpoint que Twilio appelle (via TWIML App) pour diriger l’appel
app.post('/voice', (req, res) => {
  const clientPhone = req.body?.To;
  const identity = req.body?.From?.replace('client:', '').toLowerCase();
  const callerId = employeeTwilioMap[identity];

  console.log("📞 Appel reçu sur /voice avec :", { body: req.body });

  if (!clientPhone || !callerId) {
    console.error("❌ Numéro de client ou callerId manquant");
    return res.status(400).send('Client phone ou CallerId manquant');
  }

  const twiml = new twilio.twiml.VoiceResponse();
  const dial = twiml.dial({ 
    callerId, 
    record: 'record-from-answer-dual',
    recordingStatusCallback: 'https://click-to-call-app.onrender.com/recording-callback',
    recordingStatusCallbackEvent: ['completed'],
  });

  dial.number(clientPhone);

  console.log("✅ Réponse TwiML envoyée :", twiml.toString());

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




// 🚀 Lancer le serveur
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Serveur en écoute sur http://localhost:${PORT}`);
});

/* require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const path = require('path');
const twilio = require('twilio');
const cors = require('cors'); // ✅ Import du middleware CORS

// Twilio JWT AccessToken
const AccessToken = twilio.jwt.AccessToken;
const VoiceGrant = AccessToken.VoiceGrant;

const app = express();
app.use(cors()); // ✅ Active CORS pour toutes les origines
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname)));

// Twilio client
const client = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

// 💾 Mapping des utilisateurs HubSpot → numéros Twilio
const employeeTwilioMap = {
  "janice@glive.ca": "+14506001665",
  // "sandra@tonentreprise.com": "+14155552672",
};

// ✅ Route de test
app.get('/', (req, res) => {
  res.send('✅ API Click-to-Call is running. Use POST /click-to-call or GET /token');
});

// ✅ Endpoint pour générer un token Twilio Client (WebRTC)
app.get('/token', (req, res) => {
  try {
    const identity = req.query.email || 'anonymous';

    const voiceGrant = new VoiceGrant({
      outgoingApplicationSid: process.env.TWIML_APP_SID,
      incomingAllow: true
    });

    const token = new AccessToken(
      process.env.TWILIO_ACCOUNT_SID,
      process.env.TWILIO_API_KEY,
      process.env.TWILIO_API_SECRET,
      { identity }
    );

    token.addGrant(voiceGrant);

    res.send({ token: token.toJwt() });
  } catch (err) {
    console.error("Erreur lors de la génération du token :", err);
    res.status(500).send("Erreur serveur lors de la génération du token.");
  }
});

// ✅ Endpoint WebRTC bridge TwiML (appel vers le client réel)
app.post('/voice', (req, res) => {
  const clientPhone = req.query.To || req.body?.To;

  console.log("📞 Appel reçu sur /voice avec :", {
    query: req.query,
    body: req.body
  });

  if (!clientPhone) {
    console.error("❌ Numéro de client manquant");
    return res.status(400).send('Client phone manquant');
  }

  const twiml = new twilio.twiml.VoiceResponse();
  twiml.dial(clientPhone);

  res.type('text/xml');
  res.send(twiml.toString());
});

// ✅ (optionnel) Ancien système pour lancer un appel depuis backend
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
    console.error("Erreur lors de l'appel Twilio :", err);
    res.status(500).send(err.message);
  }
});

// ✅ Démarrage du serveur
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Serveur en écoute sur http://localhost:${PORT}`);
}); */


/* require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const path = require('path');
const twilio = require('twilio');

const app = express();
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname)));

const client = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

// 💾 Mapping des utilisateurs HubSpot → numéros Twilio
const employeeTwilioMap = {
  "janice@glive.ca": "+14506001665",
  //"sandra@tonentreprise.com": "+14155552672",
  // Ajoute ici tous tes employés
};

app.get('/', (req, res) => {
  res.send('API Click-to-Call is running. Use POST /click-to-call to make a call.');
});

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
      from: employeeTwilioNumber, // appel sortant avec le bon numéro
      url: `${process.env.TWIML_BRIDGE_URL}?clientPhone=${encodeURIComponent(clientPhone)}`
    });

    res.send('Appel lancé avec succès.');
  } catch (err) {
    res.status(500).send(err.message);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Serveur en écoute sur http://localhost:${PORT}`);
}); */

/* require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const path = require('path');
const twilio = require('twilio');

const app = express();
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname)));

const client = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

app.get('/', (req, res) => {
  res.send('API Click-to-Call is running. Use POST /click-to-call to make a call.');
});

app.post('/click-to-call', async (req, res) => {
  const { employeePhone, clientPhone } = req.body;

  if (!employeePhone || !clientPhone) {
    return res.status(400).send('Numéros manquants.');
  }

  try {
    await client.calls.create({
      to: employeePhone,
      from: process.env.TWILIO_NUMBER,
      url: `${process.env.TWIML_BRIDGE_URL}?clientPhone=${encodeURIComponent(clientPhone)}`
    });

    res.send('Appel lancé à l’employé.');
  } catch (err) {
    res.status(500).send(err.message);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Serveur en écoute sur http://localhost:${PORT}`);
}); */
