import 'dotenv/config';
import pino from 'pino';
import qrcode from 'qrcode-terminal';
import makeWASocket, {
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  downloadMediaMessage,
  DisconnectReason,
} from '@whiskeysockets/baileys';

// ---------- Configuración ----------
const BOT_TOKEN = process.env.DISCORD_BOT_TOKEN || '';
const CHANNEL_ID = process.env.DISCORD_CHANNEL_ID || '';
const WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL || '';
const USAR_BOT = Boolean(BOT_TOKEN && CHANNEL_ID);
const TRIGGER = (process.env.TRIGGER || '/fotatos').toLowerCase();
const GROUP_ID = process.env.WHATSAPP_GROUP_ID || ''; // opcional: limitar a un grupo
const MAX_BYTES = (parseInt(process.env.MAX_MB, 10) || 10) * 1024 * 1024;
// Modo silencioso (por defecto activado): el bot nunca escribe ni reacciona en WhatsApp.
const SILENT = process.env.SILENT !== 'false';

if (!USAR_BOT && !WEBHOOK_URL) {
  console.error('Falta configurar Discord en .env: DISCORD_BOT_TOKEN + DISCORD_CHANNEL_ID (o DISCORD_WEBHOOK_URL).');
  process.exit(1);
}
console.log(`Envío a Discord: ${USAR_BOT ? 'con el bot' : 'con webhook'}`);

const logger = pino({ level: 'silent' });
const vistos = new Set();
let sock;

process.on('unhandledRejection', (e) => console.error('Promesa rechazada:', e));

// ---------- Utilidades de mensajes ----------
// Algunos mensajes vienen "envueltos" (temporales, ver una vez, etc.)
function desenvolver(message) {
  let m = message;
  for (let i = 0; i < 5 && m; i++) {
    const interno =
      m.ephemeralMessage?.message ||
      m.viewOnceMessage?.message ||
      m.viewOnceMessageV2?.message ||
      m.documentWithCaptionMessage?.message ||
      m.editedMessage?.message;
    if (!interno) break;
    m = interno;
  }
  return m;
}

function textoDe(m) {
  return (
    m?.conversation ||
    m?.extendedTextMessage?.text ||
    m?.imageMessage?.caption ||
    m?.videoMessage?.caption ||
    m?.documentMessage?.caption ||
    ''
  );
}

function mediaDe(m) {
  if (!m) return null;
  if (m.imageMessage) return { tipo: 'image', info: m.imageMessage };
  if (m.videoMessage) return { tipo: 'video', info: m.videoMessage };
  const d = m.documentMessage;
  if (d && /^(image|video)\//.test(d.mimetype || '')) return { tipo: 'document', info: d };
  return null;
}

function contextoDe(m) {
  const x = m?.extendedTextMessage || m?.imageMessage || m?.videoMessage || m?.documentMessage;
  return x?.contextInfo;
}

function extensionDe(mimetype) {
  const sub = (mimetype.split('/')[1] || 'bin').split(';')[0];
  return sub === 'jpeg' ? 'jpg' : sub;
}

// En modo silencioso solo se escribe en la consola; si no, también se responde en el grupo.
async function avisar(jid, msg, texto) {
  console.log(`[aviso] ${texto}`);
  if (!SILENT) await sock.sendMessage(jid, { text: texto }, { quoted: msg }).catch(() => {});
}

async function reaccionar(jid, msg, emoji) {
  if (!SILENT) await sock.sendMessage(jid, { react: { text: emoji, key: msg.key } }).catch(() => {});
}

// ---------- Discord ----------
async function enviarADiscord({ buffer, mimetype, filename, contenido }) {
  const form = new FormData();
  form.append(
    'payload_json',
    JSON.stringify({
      content: contenido,
      allowed_mentions: { parse: [] }, // evita pings por @everyone, etc.
    })
  );
  form.append('files[0]', new Blob([buffer], { type: mimetype }), filename);

  // Con el bot se usa la API REST de Discord (no hace falta que el bot esté "online");
  // el mensaje sale con el nombre y la foto del bot.
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

// ---------- Lógica principal ----------
async function manejarMensaje(msg) {
  const jid = msg.key?.remoteJid;
  if (!jid || !jid.endsWith('@g.us') || !msg.message) return; // solo grupos

  // Ignorar mensajes viejos (por ejemplo, los que llegan al reconectar)
  const ts = Number(msg.messageTimestamp || 0);
  if (ts && Date.now() / 1000 - ts > 120) return;

  const m = desenvolver(msg.message);
  const texto = textoDe(m).trim();
  const textoMin = texto.toLowerCase();

  if (!textoMin.includes(TRIGGER) && textoMin !== '/grupoid') return;

  // Evitar procesar dos veces el mismo mensaje
  const id = msg.key.id;
  if (vistos.has(id)) return;
  vistos.add(id);
  if (vistos.size > 500) vistos.delete(vistos.values().next().value);

  // Comando auxiliar para averiguar el ID del grupo
  if (textoMin === '/grupoid') {
    await avisar(jid, msg, `ID del grupo: ${jid}`);
    return;
  }

  if (GROUP_ID && jid !== GROUP_ID) return;

  // La foto puede venir en el mismo mensaje o en el mensaje citado
  let objetivo = null;
  const propia = mediaDe(m);
  if (propia) {
    objetivo = { mensaje: msg, media: propia };
  } else {
    const ctx = contextoDe(m);
    const citado = ctx?.quotedMessage ? desenvolver(ctx.quotedMessage) : null;
    const delCitado = mediaDe(citado);
    if (delCitado) {
      objetivo = {
        media: delCitado,
        mensaje: {
          key: { remoteJid: jid, id: ctx.stanzaId, fromMe: false, participant: ctx.participant },
          message: ctx.quotedMessage,
        },
      };
    }
  }

  if (!objetivo) {
    await avisar(jid, msg, `No encontré ninguna foto: mandala con "${TRIGGER}" de epígrafe, o respondé a una foto con "${TRIGGER}".`);
    return;
  }

  try {
    const buffer = await downloadMediaMessage(
      objetivo.mensaje,
      'buffer',
      {},
      { logger, reuploadRequest: sock.updateMediaMessage }
    );

    if (buffer.length > MAX_BYTES) {
      const mb = (buffer.length / 1024 / 1024).toFixed(1);
      await avisar(jid, msg, `El archivo pesa ${mb} MB y el límite es ${MAX_BYTES / 1024 / 1024} MB.`);
      return;
    }

    const { tipo, info } = objetivo.media;
    const mimetype = info.mimetype || (tipo === 'video' ? 'video/mp4' : 'image/jpeg');
    const filename = info.fileName || `fotatos_${Date.now()}.${extensionDe(mimetype)}`;

    const nombre = msg.pushName || 'alguien';
    const comentario = texto.replace(new RegExp(TRIGGER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), '').trim();
    const contenido = `📸 Enviado por **${nombre}**${comentario ? `\n${comentario}` : ''}`;

    await enviarADiscord({ buffer, mimetype, filename, contenido });
    await reaccionar(jid, msg, '✅');
    console.log(`Enviado a Discord: ${filename} (de ${nombre})`);
  } catch (err) {
    console.error('Error al enviar a Discord:', err);
    await avisar(jid, msg, 'No pude subirlo a Discord, probá de nuevo.');
  }
}

// ---------- Conexión a WhatsApp ----------
async function iniciar() {
  const { state, saveCreds } = await useMultiFileAuthState('auth_baileys');

  const config = {
    auth: state,
    logger,
    markOnlineOnConnect: false, // no aparecer "en línea" ni quitarte notificaciones del celular
    syncFullHistory: false,
  };
  try {
    const { version } = await fetchLatestBaileysVersion();
    config.version = version;
  } catch {
    // si falla, se usa la versión por defecto de la librería
  }

  sock = makeWASocket(config);

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      console.log('Escaneá este QR con WhatsApp (Dispositivos vinculados > Vincular un dispositivo):');
      qrcode.generate(qr, { small: true });
    }
    if (connection === 'open') {
      console.log(
        `Bot listo. Disparador: "${TRIGGER}" | Modo silencioso: ${SILENT ? 'SÍ' : 'NO'} | Grupo: ${GROUP_ID || 'cualquiera'}`
      );
    }
    if (connection === 'close') {
      const codigo = lastDisconnect?.error?.output?.statusCode;
      if (codigo === DisconnectReason.loggedOut) {
        console.error('Sesión cerrada desde el celular. Borrá la carpeta auth_baileys y volvé a vincular.');
        process.exit(1);
      }
      console.log(`Conexión cerrada (código ${codigo ?? 'desconocido'}). Reconectando...`);
      setTimeout(() => iniciar().catch((e) => console.error('Error al reconectar:', e)), 3000);
    }
  });

  sock.ev.on('messages.upsert', ({ messages }) => {
    for (const msg of messages) {
      manejarMensaje(msg).catch((e) => console.error('Error manejando mensaje:', e));
    }
  });
}

iniciar().catch((e) => {
  console.error('No se pudo iniciar:', e);
  process.exit(1);
});
