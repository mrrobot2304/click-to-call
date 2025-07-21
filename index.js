require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const path = require('path');
const twilio = require('twilio');
const cors = require('cors');

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
  const to = req.body?.To;
  const from = req.body?.From;
  const isIncoming = to?.startsWith('client:');
  const identity = isIncoming ? to.replace('client:', '').toLowerCase() : from?.replace('client:', '').toLowerCase();
  const callerId = employeeTwilioMap[identity];

  console.log("📞 Appel reçu sur /voice avec :", { to, from, isIncoming });

  if (!to) {
    console.error("❌ Champ 'To' manquant");
    return res.status(400).send('Champ "To" manquant');
  }

  const twiml = new twilio.twiml.VoiceResponse();
  const dial = twiml.dial({
    callerId: callerId || from, // Si sortant : callerId = TwilioUser ; entrant : callerId = numéro externe
    record: 'record-from-answer-dual',
    recordingStatusCallback: 'https://click-to-call-app.onrender.com/recording-callback',
    recordingStatusCallbackEvent: ['completed'],
  });

  if (isIncoming) {
    const targetClient = to.replace('client:', '').toLowerCase();
    dial.client(targetClient);
    console.log("📥 Appel entrant routé vers client :", targetClient);
  } else {
    dial.number(to);
    console.log("📤 Appel sortant vers numéro :", to);
  }

  console.log("✅ Réponse TwiML envoyée :", twiml.toString());
  res.type('text/xml').send(twiml.toString());
});



// 📞 Ancien Endpoint que Twilio appelle (via TWIML App) pour diriger l’appel
/* app.post('/voice', (req, res) => {
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
}); */

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

