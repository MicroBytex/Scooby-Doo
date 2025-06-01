const { makeWASocket, useMultiFileAuthState, DisconnectReason, delay } = require('@whiskeysockets/baileys');
const pino = require('pino');
const qrcode = require('qrcode-terminal'); // <-- ¡IMPORTAMOS qrcode-terminal AQUÍ!
const { OWNERS_JIDS, PREFIX, BOT_NAME } = require('./config');
const messageHandler = require('./messageHandler');

const startSock = async () => {
    const { state, saveCreds } = await useMultiFileAuthState('baileys_auth_info');

    const sock = makeWASocket({
        logger: pino({ level: 'silent' }),
        printQRInTerminal: false, // <-- CAMBIAMOS ESTO A FALSE para que `qrcode-terminal` maneje la impresión
        qrTimeoutMs: 60000, // Tiempo en ms que el QR estará activo
        auth: state,
        browser: ['Scooby Doo Bot', 'Chrome', '1.0.0'],
        syncFullHistory: true
    });

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        // Si hay un QR disponible en el update (el código de texto), lo mostramos con qrcode-terminal
        if (qr) {
            console.log('Escanea este QR con tu teléfono para conectar el bot:');
            qrcode.generate(qr, { small: true }); // <-- ¡USAMOS qrcode-terminal AQUÍ!
            // `small: true` para que el QR sea más compacto y se vea mejor en terminales pequeñas.
        }

        if (connection === 'close') {
            const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log('Conexión cerrada debido a:', lastDisconnect?.error);

            if (shouldReconnect) {
                console.log('Intentando reconectar...');
                await delay(3000);
                startSock();
            } else {
                console.log('¡Conexión terminada! Es necesario escanear un nuevo QR.');
                process.exit(0);
            }
        } else if (connection === 'open') {
            console.log(`✅ Conexión establecida con ${BOT_NAME}`);
            for (const ownerJid of OWNERS_JIDS) {
                await sock.sendMessage(ownerJid, { text: `✨ ¡${BOT_NAME} está en línea y listo para trabajar!` });
            }
        }
    });

    sock.ev.on('messages.upsert', async (m) => {
        if (!m.messages[0].key.fromMe && !m.messages[0].key.remoteJid.endsWith('@status')) {
            await messageHandler(sock, m);
        }
    });

    sock.ev.on('creds.update', saveCreds);

    return sock;
};

startSock();
