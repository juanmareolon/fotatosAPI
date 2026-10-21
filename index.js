require('dotenv').config();
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');

const BOT_TOKEN = process.env.DISCORD_BOT_TOKEN || '';
const CHANNEL_ID = process.env.DISCORD_CHANNEL_ID || '';
const WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL || '';
const USAR_BOT = Boolean(BOT_TOKEN && CHANNEL_ID);
const TRIGGER = (process.env.TRIGGER || '/fotatos').toLowerCase();
const GROUP_ID = process.env.WHATSAPP_GROUP_ID || ''; // opcional: limitar a un grupo
const CHROMIUM_PATH = process.env.CHROMIUM_PATH || undefined;
const MAX_BYTES = (parseInt(process.env.MAX_MB, 10) || 10) * 1024 * 1024;
const SILENT = process.env.SILENT !== 'false';

if (!USAR_BOT && !WEBHOOK_URL) {
  console.error('Falta configurar Discord en .env: DISCORD_BOT_TOKEN + DISCORD_CHANNEL_ID (o DISCORD_WEBHOOK_URL).');
  process.exit(1);
}
console.log(`Envío a Discord: ${USAR_BOT ? 'con el bot' : 'con webhook'}`);

const client = new Client({
  authStrategy: new LocalAuth({ dataPath: '.wwebjs_auth' }),
  puppeteer: {
    headless: true,
    executablePath: CHROMIUM_PATH,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
    ],
  },
});

client.on('qr', (qr) => {
  console.log('Escaneá este QR con el WhatsApp del número del bot (Dispositivos vinculados):');
  qrcode.generate(qr, { small: true });
});

client.on('authenticated', () => console.log('Sesión autenticada.'));
client.on('auth_failure', (m) => console.error('Falló la autenticación:', m));
client.on('disconnected', (r) => console.error('Desconectado:', r));
client.on('ready', () =>
  console.log(
    `Bot listo. Disparador: "${TRIGGER}" | Modo silencioso: ${SILENT ? 'SÍ' : 'NO'} | Grupo: ${GROUP_ID || 'cualquiera'}`
  )
);

function extensionDe(mimetype) {
  const sub = (mimetype.split('/')[1] || 'bin').split(';')[0];
  return sub === 'jpeg' ? 'jpg' : sub;
}

async function avisar(msg, texto) {
  console.log(`[aviso] ${texto}`);
  if (!SILENT) await msg.reply(texto).catch(() => {});
}

async function reaccionar(msg, emoji) {
  if (!SILENT) await msg.react(emoji).catch(() => {});
}

async function enviarADiscord({ buffer, mimetype, filename, contenido }) {
  const form = new FormData();
  form.append(
    'payload_json',
    JSON.stringify({
      content: contenido,
      allowed_mentions: { parse: [] },
    })
  );
  form.append('files[0]', new Blob([buffer], { type: mimetype }), filename);

  const url = USAR_BOT
    ? `https://discord.com/api/v10/channels/${CHANNEL_ID}/messages`
    : `${WEBHOOK_URL}?wait=true`;
  const headers = USAR_BOT ? { Authorization: `Bot ${BOT_TOKEN}` } : {};

  const res = await fetch(url, { method: 'POST', headers, body: form });
  if (!res.ok) {
    const detalle = await res.text().catch(() => '');
    throw new Error(`Discord respondió ${res.status}: ${detalle}`);
  }
}

async function manejarMensaje(msg) {
  const texto = (msg.body || '').trim();
  const textoMin = texto.toLowerCase();

  if (!textoMin.includes(TRIGGER) && textoMin !== '/grupoid') return;

  const chat = await msg.getChat();
  if (!chat.isGroup) return;

  if (textoMin === '/grupoid') {
    console.log(`ID del grupo "${chat.name}": ${chat.id._serialized}`);
    await avisar(msg, `ID del grupo "${chat.name}": ${chat.id._serialized}`);
    return;
  }

  if (GROUP_ID && chat.id._serialized !== GROUP_ID) return;

  let objetivo = null;
  if (msg.hasMedia) {
    objetivo = msg;
  } else if (msg.hasQuotedMsg) {
    const citado = await msg.getQuotedMessage();
    if (citado.hasMedia) objetivo = citado;
  }

  if (!objetivo) {
    await avisar(msg, `No encontré ninguna foto: mandala con "${TRIGGER}" de epígrafe, o respondé a una foto con "${TRIGGER}".`);
    return;
  }

  try {
    const media = await objetivo.downloadMedia();
    if (!media || !(media.mimetype.startsWith('image/') || media.mimetype.startsWith('video/'))) {
      await avisar(msg, 'Solo puedo subir fotos o videos.');
      return;
    }

    const buffer = Buffer.from(media.data, 'base64');
    if (buffer.length > MAX_BYTES) {
      const mb = (buffer.length / 1024 / 1024).toFixed(1);
      await avisar(msg, `El archivo pesa ${mb} MB y el límite es ${MAX_BYTES / 1024 / 1024} MB.`);
      return;
    }

    const contacto = await msg.getContact();
    const nombre = contacto.pushname || contacto.name || 'alguien';
    const comentario = texto.replace(new RegExp(TRIGGER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), '').trim();
    const contenido = `📸 Enviado por **${nombre}**${comentario ? `\n${comentario}` : ''}`;

    const filename = media.filename || `fotatos_${Date.now()}.${extensionDe(media.mimetype)}`;

    await enviarADiscord({ buffer, mimetype: media.mimetype, filename, contenido });
    await reaccionar(msg, '✅');
    console.log(`Enviado a Discord: ${filename} (de ${nombre})`);
  } catch (err) {
    console.error('Error al enviar a Discord:', err);
    await avisar(msg, 'No pude subirlo a Discord, probá de nuevo.');
  }
}

client.on('message_create', (msg) => {
  manejarMensaje(msg).catch((e) => console.error('Error manejando mensaje:', e));
});

client.initialize();
