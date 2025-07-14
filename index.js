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
});
