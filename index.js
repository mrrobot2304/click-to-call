require('dotenv').config();
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
});

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
