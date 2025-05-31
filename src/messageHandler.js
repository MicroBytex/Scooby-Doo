const { readFileSync, writeFileSync, unlinkSync, existsSync } = require('fs');
const path = require('path');
const { IMGBB_API_KEY, OWNERS_JIDS, PREFIX, BOT_NAME, WHATSAPP_CHANNEL_LINK, WEATHER_API_KEY } = require('./config');
const axios = require('axios');
const FormData = require('form-data');
const ytdl = require('ytdl-core');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('@ffmpeg-installer/ffmpeg').path;
ffmpeg.setFfmpegPath(ffmpegPath);
const cheerio = require('cheerio');
const streamToBuffer = require('stream-to-buffer');
const { execSync } = require('child_process');
const { instagramdl } = require('@bochilteam/scraper');
const { setupCache } = require('axios-cache-interceptor');
const weather = require('weather-js');
const qrcode = require('qrcode');

const cachedAxios = axios.create();
const axiosInstance = setupCache(cachedAxios);

const REGISTERED_USERS_FILE = path.join(__dirname, '../data/registered_users.json');
const ECONOMY_FILE = path.join(__dirname, '../data/economy.json');

if (!existsSync(REGISTERED_USERS_FILE)) {
    writeFileSync(REGISTERED_USERS_FILE, JSON.stringify({}));
}
if (!existsSync(ECONOMY_FILE)) {
    writeFileSync(ECONOMY_FILE, JSON.stringify({}));
}

let registeredUsers = JSON.parse(readFileSync(REGISTERED_USERS_FILE, 'utf-8'));
let economyData = JSON.parse(readFileSync(ECONOMY_FILE, 'utf-8'));

const saveRegisteredUsers = () => {
    writeFileSync(REGISTERED_USERS_FILE, JSON.stringify(registeredUsers, null, 2));
};

const saveEconomyData = () => {
    writeFileSync(ECONOMY_FILE, JSON.stringify(economyData, null, 2));
};

const isCommand = (text) => text.startsWith(PREFIX);
const getArgs = (text) => text.slice(PREFIX.length).trim().split(/ +/g);
const getCommandName = (text) => getArgs(text).shift().toLowerCase();
const isOwner = (sender) => OWNERS_JIDS.includes(sender);
const isGroup = (jid) => jid.endsWith('@g.us');

const usersWaitingForImage = {};

const sendReplyButtons = async (sock, jid, text, buttons, footer = '', imageBuffer = null) => {
    let messageOptions = {
        text: text,
        footer: footer,
        buttons: buttons,
        headerType: 1
    };

    if (imageBuffer) {
        messageOptions.image = imageBuffer;
        messageOptions.caption = text;
        messageOptions.headerType = 4;
        delete messageOptions.text;
    }
    return await sock.sendMessage(jid, messageOptions);
};

const uploadImageToImgBB = async (imageBuffer) => {
    const form = new FormData();
    form.append('image', imageBuffer, { filename: 'image.png', contentType: 'image/png' });

    try {
        const response = await axiosInstance.post(`https://api.imgbb.com/1/upload?key=${IMGBB_API_KEY}`, form, {
            headers: form.getHeaders(),
        });
        return response.data.data.url;
    } catch (error) {
        console.error('Error al subir la imagen a ImgBB:', error.response ? error.response.data : error.message);
        throw new Error('No se pudo subir la imagen a ImgBB. Asegúrate de que la API Key sea válida.');
    }
};

const messageHandler = async (sock, m) => {
    const msg = m.messages[0];
    if (!msg || !msg.message) return;

    const text = msg.message.extendedTextMessage?.text || msg.message.conversation || '';
    const jid = msg.key.remoteJid;
    const sender = msg.key.participant || jid;
    const pushName = msg.pushName || 'Usuario';
    const messageType = Object.keys(msg.message)[0];
    const quotedMessage = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
    const quotedParticipant = msg.message?.extendedTextMessage?.contextInfo?.participant;

    const now = Date.now();

    let isBotAdmin = false;
    let isSenderAdmin = false;
    let groupParticipants = [];

    if (isGroup(jid)) {
        try {
            const groupMetadata = await sock.groupMetadata(jid);
            groupParticipants = groupMetadata.participants;

            const botParticipant = groupParticipants.find(p => p.id === sock.user.id);
            const senderParticipant = groupParticipants.find(p => p.id === sender);
            
            isBotAdmin = botParticipant && (botParticipant.admin === 'admin' || botParticipant.admin === 'superadmin');
            isSenderAdmin = senderParticipant && (senderParticipant.admin === 'admin' || senderParticipant.admin === 'superadmin');
        } catch (e) {
            console.error('Error al obtener metadatos del grupo:', e);
        }
    }

    if (usersWaitingForImage[sender] && messageType === 'imageMessage') {
        delete usersWaitingForImage[sender];

        try {
            await sock.sendMessage(jid, { text: '🔄 Subiendo tu imagen a ImgBB, por favor espera...' });
            const stream = await sock.downloadMediaMessage(msg.message.imageMessage);
            const buffer = await new Promise((resolve, reject) => {
                streamToBuffer(stream, (err, buf) => {
                    if (err) reject(err);
                    resolve(buf);
                });
            });
            const imageUrl = await uploadImageToImgBB(buffer);
            await sock.sendMessage(jid, { text: `✨ ¡Tu imagen ha sido subida! Aquí está tu enlace directo: \n\n${imageUrl}` });
        } catch (error) {
            console.error('Error al subir la imagen después de /subir:', error);
            await sock.sendMessage(jid, { text: `❌ Hubo un error al intentar subir tu imagen: ${error.message}` });
        }
        return;
    }

    if (!isCommand(text)) return;

    const commandName = getCommandName(text);
    const args = getArgs(text).slice(1);
    const fullArgs = args.join(' ');

    console.log(`Comando recibido: ${commandName} de ${sender} en ${isGroup(jid) ? 'grupo' : 'chat individual'}`);

    if (commandName !== 'register' && !isOwner(sender) && !registeredUsers[sender]) {
        await sock.sendMessage(jid, { text: `👋 Hola ${pushName}, para usar ${BOT_NAME} primero debes registrarte. Usa el comando: \n\n\`${PREFIX}register <usuario> <edad>\`\n\nEjemplo: \`${PREFIX}register Pedro 25\`` });
        return;
    }

    switch (commandName) {
        case 'register':
            if (isOwner(sender)) {
                await sock.sendMessage(jid, { text: '✨ Eres el creador del bot, no necesitas registrarte.' });
                return;
            }
            if (registeredUsers[sender]) {
                await sock.sendMessage(jid, { text: `✅ ${pushName}, ¡ya estás registrado! Tu nombre es: ${registeredUsers[sender].username}, Edad: ${registeredUsers[sender].age}` });
                return;
            }
            if (args.length < 2) {
                await sock.sendMessage(jid, { text: `Uso correcto: ${PREFIX}register <usuario> <edad>\n\nEjemplo: ${PREFIX}register Pedro 25` });
                return;
            }
            const username = args[0];
            const age = parseInt(args[1]);

            if (isNaN(age) || age < 5 || age > 100) {
                await sock.sendMessage(jid, { text: 'Por favor, introduce una edad válida (número entre 5 y 100).' });
                return;
            }

            registeredUsers[sender] = { username, age, registeredAt: Date.now() };
            saveRegisteredUsers();
            await sock.sendMessage(jid, { text: `🎉 ¡Felicidades ${username}! Te has registrado correctamente en ${BOT_NAME}. ¡Bienvenido!` });
            break;

        case 'help':
        case 'menu':
            const imagePath = path.join(__dirname, '../assets/menu_help.png');
            let menuImageBuffer;
            try {
                menuImageBuffer = readFileSync(imagePath);
            } catch (error) {
                console.error('Error al cargar la imagen de ayuda:', error.message);
                menuImageBuffer = null;
            }

            const helpMessage = `❖ ─ ✦ ──『✙』── ✦ ─ ❖
┃
┣ *${BOT_NAME}* 🌠
┣ Creador ☕︎: *KaitoNeko* 👑
┣ Plataforma ⚚: *Linux* 🐧
┣ Prefijo 𖤝: [ ${PREFIX} ]
┣ Tipo ⓘ:  *Oficial* 🍀
❖ ─ ✦ ──『✙』── ✦ ─ ❖

*Canal 🍁:* ${WHATSAPP_CHANNEL_LINK}

✦ ── ✧ ─── ✦ ── ✧ ── ✦  
       *🛠️ 𝗠𝗘𝗡𝗨́ GENERAL* ✨  
✦ ── ✧ ─── ✦ ── ✧ ── ✦  

🔹 ${PREFIX}register ＋ <usuario> <edad>
    → 📝 Registrate para usar el bot

🔹 ${PREFIX}report ＋ [error]  
   → 📩 𝗘𝗻𝘃𝗶́𝗮 𝗿𝗲𝗽𝗼𝗿𝘁𝗲𝘀 𝗮𝗹 staff  

🔹 ${PREFIX}suggest ＋ [idea]  
   → 🗳️ 𝗦𝘂𝗴𝗲𝗿𝗲𝗻𝗰𝗶𝗮𝘀 𝗽𝗮𝗿𝗮 𝗲𝗹 𝗯𝗼𝘁  

🔹 ${PREFIX}help  
   → 📚 𝗠𝘂́e𝘀𝘁𝗿𝗮 𝗹𝗮 𝗮𝘆𝘂𝗱𝗮 𝗱𝗲 𝗰𝗼𝗺𝗮𝗻𝗱𝗼𝘀  

🔹 ${PREFIX}serbot  
   → 🍀 Conviertete en subbot

🔹 ${PREFIX}subir
    → ⬆️ Sube una imagen a ImgBB
    
🔹 ${PREFIX}info
    → ℹ️ Muestra información del bot
    
🔹 ${PREFIX}say + <texto>
    → 🗣️ El bot repite tu mensaje
    
🔹 ${PREFIX}ping
    → ⚡ Mide la latencia del bot
    
🔹 ${PREFIX}qr + <texto/URL>
    → 📷 Genera un código QR
    
🔹 ${PREFIX}readmore + <texto1> | <texto2>
    → 📖 Muestra texto con "Leer más"
    
🔹 ${PREFIX}shorturl + <URL>
    → 🔗 Acorta una URL
    
🔹 ${PREFIX}weather + <ciudad>
    → ☀️ Muestra el clima de una ciudad
    
🔹 ${PREFIX}wikipedia + <término>
    → 🌐 Busca en Wikipedia

🔹 ${PREFIX}cat
    → 🐾 Envía una imagen aleatoria de un gato

🔹 ${PREFIX}dog
    → 🐶 Envía una imagen aleatoria de un perro

🔹 ${PREFIX}fact
    → 💡 Envía un hecho aleatorio

🔹 ${PREFIX}chucknorris
    → 😂 Envía un chiste aleatorio de Chuck Norris

🔹 ${PREFIX}8ball + <pregunta>
    → 🔮 Responde a tus preguntas (sí/no)

🔹 ${PREFIX}dice
    → 🎲 Lanza un dado (1-6)

✦ ── ✧ ─── ✦ ── ✧ ── ✦

✦ ── ✧ ─── ✦ ── ✧ ── ✦  
       *👥 𝗠𝗘𝗡𝗨́ ADMIN* ✨  
✦ ── ✧ ─── ✦ ── ✧ ── ✦  

🔹 ${PREFIX}kick  + <usuario>
   → Elimina a un usuario

🔹 ${PREFIX}demote + <usuario>
   → Quita admin a un usuario

🔹 ${PREFIX}promote + <usuario>
   → Hace admin a un usuario

🔹 ${PREFIX}tagall
   → @Menciona a todos en el grupo

🔹 ${PREFIX}hidetag + <texto>
   → Envía un mensaje sin mencionar

🔹 ${PREFIX}close  
   → Cerrar el grupo

🔹 ${PREFIX}open  
   → Abrir el grupo 

🔹 ${PREFIX}antilink + [ on ] / [ off ]

   → Activa el sistema Antilink

🔹 ${PREFIX}setname + <texto>
   → Ponle un nombre al grupo 

🔹 ${PREFIX}setimagen 
   → Cámbiale la foto del grupo
    
🔹 ${PREFIX}linkgroup
   → 🔗 Obtiene el enlace del grupo
    
🔹 ${PREFIX}revoke
   → ♻️ Revoca el enlace del grupo
    
🔹 ${PREFIX}leave
   → 👋 El bot sale del grupo

✦ ── ✧ ─── ✦ ── ✧ ── ✦

✦ ── ✧ ─── ✦ ── ✧ ── ✦  
       *🍀 𝗠𝗘𝗡𝗨́ ECONOMIA* ✨  
✦ ── ✧ ─── ✦ ── ✧ ── ✦  

🔹 ${PREFIX}daily 
   → Reclama tu recompensa diaria

🔹 ${PREFIX}slut  
   → Gana dinero prostituyendote 

🔹 ${PREFIX}chest  
   → Ve en búsqueda del tesoro 

🔹 ${PREFIX}work  • ${PREFIX}w
   → Trabaja y gana coins

🔹 ${PREFIX}baltop  
   → Mira la tabla de usuarios con más coins

✦ ── ✧ ─── ✦ ── ✧ ── ✦

✦ ── ✧ ─── ✦ ── ✧ ── ✦  
       *🛠️ 𝗠𝗘𝗡𝗨́ DOWNLOADER* ✨  
✦ ── ✧ ─── ✦ ── ✧ ── ✦  

🔹 ${PREFIX}ytmp3 + <link>
   → Descarga un vídeo de YouTube 

🔹 ${PREFIX}mediafire + <link>
   → Descarga un archivo de mediafire

🔹 ${PREFIX}mega + <link> 
   → Descarga un archivo de Mega

🔹 ${PREFIX}igdl + <link>
    → 📸 Descarga fotos/videos de Instagram

✦ ── ✧ ─── ✦ ── ✧ ── ✦

✦ ── ✧ ─── ✦ ── ✧ ── ✦  
       *🛠️ 𝗠𝗘𝗡𝗨́ UTIL* ✨  
✦ ── ✧ ─── ✦ ── ✧ ── ✦  

🔹 ${PREFIX}foro  
   → Accede al foro de Scooby Doo 

🔹 ${PREFIX}pfp + <usuario>
   → obtiene la foto de perfil 

🔹 ${PREFIX}redeem + <code>
   → Canjea y disfruta de tu sorpresa
    
🔹 ${PREFIX}sticker
    → 🖼️ Convierte imagen a sticker (citar imagen)
    
🔹 ${PREFIX}toimg
    → 🏞️ Convierte sticker a imagen (citar sticker)

✦ ── ✧ ─── ✦ ── ✧ ── ✦

> By *KaitoNeko* 👑`;

            const helpButtons = [
                { buttonId: `${PREFIX}general_menu`, buttonText: { displayText: '🛠️ General' }, type: 1 },
                { buttonId: `${PREFIX}admin_menu`, buttonText: { displayText: '👥 Admin' }, type: 1 },
                { buttonId: `${PREFIX}economy_menu`, buttonText: { displayText: '🍀 Economía' }, type: 1 },
                { buttonId: `${PREFIX}downloader_menu`, buttonText: { displayText: '🛠️ Descargas' }, type: 1 },
                { buttonId: `${PREFIX}util_menu`, buttonText: { displayText: '🛠️ Utilidades' }, type: 1 },
                { buttonId: `follow_channel`, buttonText: { displayText: '📢 Seguir Canal' }, type: 1 }
            ];

            await sendReplyButtons(sock, jid, helpMessage, helpButtons, 'By KaitoNeko 👑', menuImageBuffer);
            break;
        
        case 'join':
            if (!isOwner(sender)) {
                await sock.sendMessage(jid, { text: '🚫 Solo el *creador* del bot puede usar este comando.' });
                return;
            }
            const inviteLink = args[0];
            if (!inviteLink || !inviteLink.includes('chat.whatsapp.com/')) {
                await sock.sendMessage(jid, { text: `Por favor, proporciona un enlace de invitación de grupo válido. Ejemplo: ${PREFIX}join https://chat.whatsapp.com/ABCDEF12345` });
                return;
            }
            const code = inviteLink.split('chat.whatsapp.com/')[1];
            try {
                await sock.groupAcceptInvite(code);
                await sock.sendMessage(jid, { text: '✅ ¡Me he unido al grupo con éxito!' });
            } catch (e) {
                console.error('Error al unirse al grupo:', e);
                await sock.sendMessage(jid, { text: '❌ No pude unirme al grupo. Asegúrate de que el enlace es válido y no ha expirado.' });
            }
            break;

        case 'subir':
            usersWaitingForImage[sender] = true;
            await sock.sendMessage(jid, { text: '🖼️ Por favor, *envía la imagen* que deseas subir a ImgBB ahora.' });
            break;

        case 'report':
            if (!fullArgs) {
                await sock.sendMessage(jid, { text: `Por favor, proporciona un error o problema para reportar. Ejemplo: ${PREFIX}report No funciona el comando /daily` });
                return;
            }
            for (const ownerJid of OWNERS_JIDS) {
                await sock.sendMessage(ownerJid, {
                    text: `🚨 *NUEVO REPORTE:* \n\nDe: @${sender.split('@')[0]}\n\nMensaje: ${fullArgs}`
                }, { quoted: msg, mentions: [sender] });
            }
            await sock.sendMessage(jid, { text: '✅ Tu reporte ha sido enviado al staff. ¡Gracias por tu ayuda!' });
            break;

        case 'suggest':
            if (!fullArgs) {
                await sock.sendMessage(jid, { text: `Por favor, proporciona tu sugerencia. Ejemplo: ${PREFIX}suggest Agrega un comando para buscar recetas` });
                return;
            }
            for (const ownerJid of OWNERS_JIDS) {
                await sock.sendMessage(ownerJid, {
                    text: `💡 *NUEVA SUGERENCIA:* \n\nDe: @${sender.split('@')[0]}\n\nSugerencia: ${fullArgs}`
                }, { quoted: msg, mentions: [sender] });
            }
            await sock.sendMessage(jid, { text: '🗳️ Tu sugerencia ha sido enviada. ¡Agradecemos tus ideas!' });
            break;

        case 'serbot':
            if (!sock.user.id.includes(':')) {
                await sock.sendMessage(jid, { text: 'Este bot no puede generar códigos de emparejamiento para sub-bots en esta configuración de sesión. La sesión principal debe iniciarse con un código de emparejamiento (opción `getPairingCode: true` en `makeWASocket` en `index.js`) para permitir la creación de "sub-bots" de esta manera.' });
                return;
            }

            await sock.sendMessage(jid, { text: '⏳ Generando código de emparejamiento, por favor espera...' });

            try {
                const { code: pairingCode } = await sock.requestPairingCode(jid.split('@')[0]);

                if (pairingCode) {
                    const message = `✨ *Tu código de emparejamiento de Scooby Doo Bot es:* ✨

\`\`\`
${pairingCode}
\`\`\`

*Instrucciones:*
1. En tu teléfono, abre WhatsApp.
2. Ve a *Ajustes* (o *Configuración*).
3. Selecciona *Dispositivos vinculados*.
4. Toca *Vincular un dispositivo*.
5. Toca *Vincular con el número de teléfono*.
6. Ingresa el código de 6 dígitos: *${pairingCode}*

Tienes 30 segundos antes de que el código expire.
`;
                    const serbotButtons = [
                        { buttonId: 'copy_code_info', buttonText: { displayText: '📋 Copiar Código' }, type: 1 }
                    ];
                    await sendReplyButtons(sock, jid, message, serbotButtons, 'By KaitoNeko 👑');
                } else {
                    await sock.sendMessage(jid, { text: '❌ No se pudo generar el código de emparejamiento. Intenta de nuevo más tarde.' });
                }
            } catch (e) {
                console.error('Error al generar código de emparejamiento para /serbot:', e);
                await sock.sendMessage(jid, { text: '❌ Ocurrió un error inesperado al intentar generar el código de emparejamiento. Asegúrate de que el bot principal esté configurado correctamente para esta función.' });
            }
            break;
        
        case 'info':
            const botInfo = `
*${BOT_NAME}*
Creador: KaitoNeko
Plataforma: Node.js (JavaScript)
Librería: Baileys
Prefijo: ${PREFIX}
Versión: 1.0.0 (Ejemplo)

Este bot está diseñado para ayudarte con diversas tareas de administración de grupo, descargas y diversión.
`;
            await sock.sendMessage(jid, { text: botInfo });
            break;

        case 'say':
            if (!fullArgs) {
                await sock.sendMessage(jid, { text: `Debes proporcionar el texto que quieres que el bot repita. Ejemplo: ${PREFIX}say Hola a todos` });
                return;
            }
            await sock.sendMessage(jid, { text: fullArgs });
            break;

        case 'ping':
            const start = Date.now();
            const sentMsg = await sock.sendMessage(jid, { text: 'Pinging...' });
            const end = Date.now();
            const latency = end - start;
            await sock.sendMessage(jid, { text: `Pong! ⚡ Latencia: ${latency}ms` }, { quoted: sentMsg });
            break;

        case 'qr':
            if (!fullArgs) {
                await sock.sendMessage(jid, { text: `Por favor, proporciona el texto o URL para generar el QR. Ejemplo: ${PREFIX}qr https://google.com` });
                return;
            }
            try {
                const qrBuffer = await qrcode.toBuffer(fullArgs, { type: 'png', margin: 1, scale: 8 });
                await sock.sendMessage(jid, { image: qrBuffer, caption: 'Aquí está tu código QR:' });
            } catch (e) {
                console.error('Error al generar QR:', e);
                await sock.sendMessage(jid, { text: '❌ Ocurrió un error al generar el código QR. Asegúrate de que la URL/texto es válido.' });
            }
            break;
        
        case 'readmore':
            const parts = fullArgs.split('|');
            if (parts.length < 2) {
                await sock.sendMessage(jid, { text: `Uso incorrecto. Formato: ${PREFIX}readmore <texto antes de leer más> | <texto después de leer más>` });
                return;
            }
            const textBefore = parts[0].trim();
            const textAfter = parts[1].trim(); 
            const hiddenChar = String.fromCharCode(8206);
            await sock.sendMessage(jid, { text: `${textBefore}${hiddenChar}\n${textAfter}` });
            break;

        case 'shorturl':
            const urlToShorten = args[0];
            if (!urlToShorten || !urlToShorten.startsWith('http')) {
                await sock.sendMessage(jid, { text: `Por favor, proporciona una URL válida para acortar. Ejemplo: ${PREFIX}shorturl https://longurl.com/some/really/long/path` });
                return;
            }
            try {
                const response = await axiosInstance.get(`https://api.shrtco.de/v2/shorten?url=${encodeURIComponent(urlToShorten)}`);
                if (response.data && response.data.ok) {
                    await sock.sendMessage(jid, { text: `🔗 URL acortada: ${response.data.result.full_short_link}` });
                } else {
                    await sock.sendMessage(jid, { text: '❌ No se pudo acortar la URL. Intenta con otra.' });
                }
            } catch (e) {
                console.error('Error al acortar URL:', e);
                await sock.sendMessage(jid, { text: `❌ Ocurrió un error al acortar la URL: ${e.message}` });
            }
            break;
        
        case 'weather':
            const city = fullArgs;
            if (!city) {
                await sock.sendMessage(jid, { text: `Por favor, proporciona el nombre de una ciudad. Ejemplo: ${PREFIX}weather Madrid` });
                return;
            }
            if (!WEATHER_API_KEY || WEATHER_API_KEY === 'TU_OPENWEATHERMAP_API_KEY') {
                await sock.sendMessage(jid, { text: '❌ La API Key para el clima no está configurada. Por favor, añade tu `WEATHER_API_KEY` en `src/config.js`.' });
                return;
            }
            weather.find({ search: city, degreeType: 'C', appId: WEATHER_API_KEY }, function(err, result) {
                if(err) {
                    console.error('Error al obtener el clima:', err);
                    sock.sendMessage(jid, { text: '❌ No pude obtener información del clima para esa ciudad. Asegúrate de que el nombre sea correcto y tu API Key válida.' });
                    return;
                }
                if(result.length === 0) {
                    sock.sendMessage(jid, { text: '❌ No se encontró información del clima para esa ciudad.' });
                    return;
                }
                const current = result[0].current;
                const location = result[0].location;
                const weatherMessage = `☀️ *Clima en ${location.name}*\n\n` +
                                       `Temperatura: ${current.temperature}°C\n` +
                                       `Sensación térmica: ${current.feelslike}°C\n` +
                                       `Condición: ${current.skytext}\n` +
                                       `Humedad: ${current.humidity}%\n` +
                                       `Viento: ${current.winddisplay}\n` +
                                       `Observación: ${current.observationpoint}\n` +
                                       `Fecha/Hora: ${current.date} ${current.observationtime}`;
                sock.sendMessage(jid, { text: weatherMessage });
            });
            break;

        case 'wikipedia':
            const searchTerm = fullArgs;
            if (!searchTerm) {
                await sock.sendMessage(jid, { text: `Por favor, proporciona un término para buscar en Wikipedia. Ejemplo: ${PREFIX}wikipedia Gatos` });
                return;
            }
            try {
                const wikiResponse = await axiosInstance.get(`https://es.wikipedia.org/w/api.php?action=query&prop=extracts&exintro&explaintext&redirects=1&format=json&titles=${encodeURIComponent(searchTerm)}`);
                const pages = wikiResponse.data.query.pages;
                const pageId = Object.keys(pages)[0];
                const extract = pages[pageId].extract;
                const title = pages[pageId].title;

                if (extract) {
                    let wikiText = `🌐 *${title}*\n\n${extract}`;
                    if (wikiText.length > 2000) {
                        wikiText = wikiText.substring(0, 1997) + '...';
                    }
                    await sock.sendMessage(jid, { text: wikiText });
                } else {
                    await sock.sendMessage(jid, { text: '❌ No se encontró información en Wikipedia para ese término.' });
                }
            } catch (e) {
                console.error('Error al buscar en Wikipedia:', e);
                await sock.sendMessage(jid, { text: `❌ Ocurrió un error al buscar en Wikipedia: ${e.message}` });
            }
            break;
        
        case 'cat':
            try {
                const response = await axiosInstance.get('https://api.thecatapi.com/v1/images/search');
                if (response.data && response.data.length > 0) {
                    await sock.sendMessage(jid, { image: { url: response.data[0].url }, caption: '¡Aquí tienes un lindo gatito! 🐾' });
                } else {
                    await sock.sendMessage(jid, { text: '❌ No pude encontrar una imagen de gato. Intenta de nuevo más tarde.' });
                }
            } catch (e) {
                console.error('Error al obtener imagen de gato:', e);
                await sock.sendMessage(jid, { text: '❌ Ocurrió un error al intentar obtener una imagen de gato.' });
            }
            break;

        case 'dog':
            try {
                const response = await axiosInstance.get('https://dog.ceo/api/breeds/image/random');
                if (response.data && response.data.status === 'success') {
                    await sock.sendMessage(jid, { image: { url: response.data.message }, caption: '¡Aquí tienes un adorable perrito! 🐶' });
                } else {
                    await sock.sendMessage(jid, { text: '❌ No pude encontrar una imagen de perro. Intenta de nuevo más tarde.' });
                }
            } catch (e) {
                console.error('Error al obtener imagen de perro:', e);
                await sock.sendMessage(jid, { text: '❌ Ocurrió un error al intentar obtener una imagen de perro.' });
            }
            break;
        
        case 'fact':
            try {
                const response = await axiosInstance.get('https://uselessfacts.jsph.pl/random.json?language=en');
                if (response.data && response.data.text) {
                    await sock.sendMessage(jid, { text: `💡 *Dato Curioso:*\n\n"${response.data.text}"` });
                } else {
                    await sock.sendMessage(jid, { text: '❌ No pude encontrar un dato curioso. Intenta de nuevo más tarde.' });
                }
            } catch (e) {
                console.error('Error al obtener dato curioso:', e);
                await sock.sendMessage(jid, { text: '❌ Ocurrió un error al intentar obtener un dato curioso.' });
            }
            break;

        case 'chucknorris':
            try {
                const response = await axiosInstance.get('https://api.chucknorris.io/jokes/random');
                if (response.data && response.data.value) {
                    await sock.sendMessage(jid, { text: `😂 *Chiste de Chuck Norris:*\n\n"${response.data.value}"` });
                } else {
                    await sock.sendMessage(jid, { text: '❌ No pude encontrar un chiste de Chuck Norris. Intenta de nuevo más tarde.' });
                }
            } catch (e) {
                console.error('Error al obtener chiste de Chuck Norris:', e);
                await sock.sendMessage(jid, { text: '❌ Ocurrió un error al intentar obtener un chiste de Chuck Norris.' });
            }
            break;

        case '8ball':
            if (!fullArgs) {
                await sock.sendMessage(jid, { text: `Por favor, haz una pregunta para la bola 8. Ejemplo: ${PREFIX}8ball ¿Seré rico?` });
                return;
            }
            const answers = [
                "Sí, definitivamente.",
                "Es cierto.",
                "Sin duda.",
                "Sí.",
                "Puedes confiar en ello.",
                "Como yo lo veo, sí.",
                "Lo más probable.",
                "Perspectiva buena.",
                "Las señales apuntan a que sí.",
                "Respuesta confusa, intenta de nuevo.",
                "Pregunta de nuevo más tarde.",
                "Mejor no decirte ahora.",
                "No puedo predecir ahora.",
                "Concéntrate y pregunta de nuevo.",
                "No cuentes con ello.",
                "Mi respuesta es no.",
                "Mis fuentes dicen que no.",
                "Las perspectivas no son buenas.",
                "Muy dudoso."
            ];
            const randomAnswer = answers[Math.floor(Math.random() * answers.length)];
            await sock.sendMessage(jid, { text: `🔮 *Pregunta:* ${fullArgs}\n\n*Respuesta de la 8-Ball:* ${randomAnswer}` });
            break;

        case 'dice':
            const roll = Math.floor(Math.random() * 6) + 1;
            await sock.sendMessage(jid, { text: `🎲 Lanzaste el dado y salió un: *${roll}*` });
            break;

        case 'kick':
            if (!isGroup(jid)) {
                await sock.sendMessage(jid, { text: 'Este comando solo puede usarse en grupos.' });
                return;
            }
            if (!isSenderAdmin) {
                await sock.sendMessage(jid, { text: 'Necesitas ser *administrador* del grupo para usar este comando.' });
                return;
            }
            if (!isBotAdmin) {
                await sock.sendMessage(jid, { text: 'Necesito ser *administrador* del grupo para poder eliminar usuarios.' });
                return;
            }

            const targetKick = quotedParticipant;
            if (!targetKick) {
                await sock.sendMessage(jid, { text: `Debes *citar* el mensaje del usuario que quieres eliminar o mencionarlo. Ejemplo: ${PREFIX}kick @usuario` });
                return;
            }
            const targetKickInfo = groupParticipants.find(p => p.id === targetKick);
            if (targetKickInfo && (targetKickInfo.admin === 'admin' || targetKickInfo.admin === 'superadmin') && sock.user.id !== targetKick && !isOwner(sender)) {
                 await sock.sendMessage(jid, { text: 'No puedo eliminar a otro administrador.' });
                 return;
            }
            if (targetKick === sock.user.id) {
                await sock.sendMessage(jid, { text: 'No puedo eliminarme a mí mismo.' });
                return;
            }

            try {
                await sock.groupParticipantsUpdate(jid, [targetKick], 'remove');
                await sock.sendMessage(jid, { text: `👋 Usuario @${targetKick.split('@')[0]} eliminado del grupo.` }, { mentions: [targetKick] });
            } catch (e) {
                console.error('Error al kickear:', e);
                if (e.data && e.data.status === 406) {
                     await sock.sendMessage(jid, { text: '❌ No pude eliminar al usuario. Asegúrate de que no es un administrador o que el bot tiene los permisos de administrador adecuados.' });
                } else {
                     await sock.sendMessage(jid, { text: `❌ Ocurrió un error inesperado al intentar eliminar al usuario: ${e.message}` });
                }
            }
            break;
        
        case 'demote':
            if (!isGroup(jid)) {
                await sock.sendMessage(jid, { text: 'Este comando solo puede usarse en grupos.' });
                return;
            }
            if (!isSenderAdmin) {
                await sock.sendMessage(jid, { text: 'Necesitas ser *administrador* del grupo para usar este comando.' });
                return;
            }
            if (!isBotAdmin) {
                await sock.sendMessage(jid, { text: 'Necesito ser *administrador* del grupo para poder degradar usuarios.' });
                return;
            }
            const targetDemote = quotedParticipant;
            if (!targetDemote) {
                await sock.sendMessage(jid, { text: `Debes *citar* el mensaje del usuario al que quieres quitar el admin. Ejemplo: ${PREFIX}demote @usuario` });
                return;
            }
            const targetDemoteInfo = groupParticipants.find(p => p.id === targetDemote);
            if (!targetDemoteInfo || (targetDemoteInfo.admin !== 'admin' && targetDemoteInfo.admin !== 'superadmin')) {
                await sock.sendMessage(jid, { text: `@${targetDemote.split('@')[0]} no es un administrador.` }, { mentions: [targetDemote] });
                return;
            }
            if (targetDemote === sock.user.id) {
                await sock.sendMessage(jid, { text: 'No puedo quitarme el rol de administrador a mí mismo.' });
                return;
            }

            try {
                await sock.groupParticipantsUpdate(jid, [targetDemote], 'demote');
                await sock.sendMessage(jid, { text: `⬇️ @${targetDemote.split('@')[0]} ya no es administrador.` }, { mentions: [targetDemote] });
            } catch (e) {
                console.error('Error al degradar:', e);
                 if (e.data && e.data.status === 406) {
                     await sock.sendMessage(jid, { text: '❌ No pude quitar el rol de administrador. Asegúrate de que el bot tiene los permisos de administrador adecuados.' });
                } else {
                     await sock.sendMessage(jid, { text: `❌ Ocurrió un error inesperado al intentar degradar al usuario: ${e.message}` });
                }
            }
            break;

        case 'promote':
            if (!isGroup(jid)) {
                await sock.sendMessage(jid, { text: 'Este comando solo puede usarse en grupos.' });
                return;
            }
            if (!isSenderAdmin) {
                await sock.sendMessage(jid, { text: 'Necesitas ser *administrador* del grupo para usar este comando.' });
                return;
            }
            if (!isBotAdmin) {
                await sock.sendMessage(jid, { text: 'Necesito ser *administrador* del grupo para poder promover usuarios.' });
                return;
            }
            const targetPromote = quotedParticipant;
            if (!targetPromote) {
                await sock.sendMessage(jid, { text: `Debes *citar* el mensaje del usuario al que quieres hacer admin. Ejemplo: ${PREFIX}promote @usuario` });
                return;
            }
            const targetPromoteInfo = groupParticipants.find(p => p.id === targetPromote);
            if (targetPromoteInfo && (targetPromoteInfo.admin === 'admin' || targetPromoteInfo.admin === 'superadmin')) {
                await sock.sendMessage(jid, { text: `@${targetPromote.split('@')[0]} ya es un administrador.` }, { mentions: [targetPromote] });
                return;
            }

            try {
                await sock.groupParticipantsUpdate(jid, [targetPromote], 'promote');
                await sock.sendMessage(jid, { text: `⬆️ @${targetPromote.split('@')[0]} ahora es administrador.` }, { mentions: [targetPromote] });
            } catch (e) {
                console.error('Error al promover:', e);
                if (e.data && e.data.status === 406) {
                     await sock.sendMessage(jid, { text: '❌ No pude hacer administrador al usuario. Asegúrate de que el bot tiene los permisos de administrador adecuados.' });
                } else {
                     await sock.sendMessage(jid, { text: `❌ Ocurrió un error inesperado al intentar promover al usuario: ${e.message}` });
                }
            }
            break;

        case 'tagall':
            if (!isGroup(jid)) {
                await sock.sendMessage(jid, { text: 'Este comando solo puede usarse en grupos.' });
                return;
            }
            if (!isSenderAdmin) {
                await sock.sendMessage(jid, { text: 'Necesitas ser *administrador* del grupo para usar este comando.' });
                return;
            }
            let mentions = [];
            let textTag = `📢 *Atención a todos los miembros:*\n\n`;
            for (let participant of groupParticipants) {
                textTag += `@${participant.id.split('@')[0]}\n`;
                mentions.push(participant.id);
            }
            await sock.sendMessage(jid, { text: textTag, mentions: mentions });
            break;

        case 'hidetag':
            if (!isGroup(jid)) {
                await sock.sendMessage(jid, { text: 'Este comando solo puede usarse en grupos.' });
                return;
            }
            if (!isSenderAdmin) {
                await sock.sendMessage(jid, { text: 'Necesitas ser *administrador* del grupo para usar este comando.' });
                return;
            }
            if (!fullArgs) {
                await sock.sendMessage(jid, { text: `Por favor, proporciona el mensaje a enviar. Ejemplo: ${PREFIX}hidetag Mensaje importante!` });
                return;
            }
            await sock.sendMessage(jid, { text: `*Mensaje oculto:*\n\n${fullArgs}`, mentions: [] });
            break;

        case 'close':
            if (!isGroup(jid)) {
                await sock.sendMessage(jid, { text: 'Este comando solo puede usarse en grupos.' });
                return;
            }
            if (!isSenderAdmin) {
                await sock.sendMessage(jid, { text: 'Necesitas ser *administrador* del grupo para usar este comando.' });
                return;
            }
            if (!isBotAdmin) {
                await sock.sendMessage(jid, { text: 'Necesito ser *administrador* del grupo para poder cerrar el grupo.' });
                return;
            }
            try {
                await sock.groupSettingUpdate(jid, 'announcement');
                await sock.sendMessage(jid, { text: '🔒 Grupo cerrado. Solo los administradores pueden enviar mensajes.' });
            } catch (e) {
                console.error('Error al cerrar grupo:', e);
                await sock.sendMessage(jid, { text: '❌ No pude cerrar el grupo.' });
            }
            break;

        case 'open':
            if (!isGroup(jid)) {
                await sock.sendMessage(jid, { text: 'Este comando solo puede usarse en grupos.' });
                return;
            }
            if (!isSenderAdmin) {
                await sock.sendMessage(jid, { text: 'Necesitas ser *administrador* del grupo para usar este comando.' });
                return;
            }
            if (!isBotAdmin) {
                await sock.sendMessage(jid, { text: 'Necesito ser *administrador* del grupo para poder abrir el grupo.' });
                return;
            }
            try {
                await sock.groupSettingUpdate(jid, 'not_announcement');
                await sock.sendMessage(jid, { text: '🔓 Grupo abierto. Ahora todos los participantes pueden enviar mensajes.' });
            } catch (e) {
                console.error('Error al abrir grupo:', e);
                await sock.sendMessage(jid, { text: '❌ No pude abrir el grupo.' });
            }
            break;

        case 'antilink':
            if (!isGroup(jid)) {
                await sock.sendMessage(jid, { text: 'Este comando solo puede usarse en grupos.' });
                return;
            }
            if (!isSenderAdmin) {
                await sock.sendMessage(jid, { text: 'Necesitas ser *administrador* del grupo para usar este comando.' });
                return;
            }
            const antilinkStatus = args[0]?.toLowerCase();
            if (antilinkStatus === 'on') {
                await sock.sendMessage(jid, { text: '🔗 Sistema Antilink *activado* en este grupo. (Requiere implementación de la lógica de detección y eliminación de enlaces)' });
            }
            else if (antilinkStatus === 'off') {
                await sock.sendMessage(jid, { text: '🚫 Sistema Antilink *desactivado* en este grupo.' });
            } else {
                await sock.sendMessage(jid, { text: `Uso: ${PREFIX}antilink [on/off]` });
            }
            break;

        case 'setname':
            if (!isGroup(jid)) {
                await sock.sendMessage(jid, { text: 'Este comando solo puede usarse en grupos.' });
                return;
            }
            if (!isSenderAdmin) {
                await sock.sendMessage(jid, { text: 'Necesitas ser *administrador* del grupo para usar este comando.' });
                return;
            }
            if (!isBotAdmin) {
                await sock.sendMessage(jid, { text: 'Necesito ser *administrador* del grupo para poder cambiar el nombre.' });
                return;
            }
            const newName = fullArgs;
            if (!newName) {
                await sock.sendMessage(jid, { text: `Por favor, proporciona el nuevo nombre para el grupo. Ejemplo: ${PREFIX}setname El Grupo de los Valientes` });
                return;
            }
            try {
                await sock.groupUpdateSubject(jid, newName);
                await sock.sendMessage(jid, { text: `✏️ El nombre del grupo ha sido cambiado a: *${newName}*` });
            } catch (e) {
                console.error('Error al cambiar nombre:', e);
                await sock.sendMessage(jid, { text: '❌ No pude cambiar el nombre del grupo.' });
            }
            break;

        case 'setimagen':
            if (!isGroup(jid)) {
                await sock.sendMessage(jid, { text: 'Este comando solo puede run as command only in groups.' });
                return;
            }
            if (!isSenderAdmin) {
                await sock.sendMessage(jid, { text: 'You need to be a *group administrator* to use this command.' });
                return;
            }
            if (!isBotAdmin) {
                await sock.sendMessage(jid, { text: 'I need to be a *group administrator* to change the group image.' });
                return;
            }
            const quotedImageForGroup = quotedMessage;
            if (!quotedImageForGroup || !quotedImageForGroup.imageMessage) {
                await sock.sendMessage(jid, { text: 'You must *quote an image* to use it as the group photo.' });
                return;
            }
            try {
                const stream = await sock.downloadMediaMessage(quotedImageForGroup);
                const buffer = await new Promise((resolve, reject) => {
                    streamToBuffer(stream, (err, buf) => {
                        if (err) reject(err);
                        resolve(buf);
                    });
                });
                await sock.updateProfilePicture(jid, buffer);
                await sock.sendMessage(jid, { text: '📸 The group photo has been updated!' });
            } catch (e) {
                console.error('Error changing group image:', e);
                await sock.sendMessage(jid, { text: '❌ I could not change the group image.' });
            }
            break;

        case 'linkgroup':
            if (!isGroup(jid)) {
                await sock.sendMessage(jid, { text: 'Este comando solo puede usarse en grupos.' });
                return;
            }
            if (!isSenderAdmin) {
                await sock.sendMessage(jid, { text: 'Necesitas ser *administrador* del grupo para usar este comando.' });
                return;
            }
            if (!isBotAdmin) {
                await sock.sendMessage(jid, { text: 'Necesito ser *administrador* del grupo para obtener el enlace de invitación.' });
                return;
            }
            try {
                const code = await sock.groupInviteCode(jid);
                await sock.sendMessage(jid, { text: `🔗 Enlace de invitación del grupo: https://chat.whatsapp.com/${code}` });
            } catch (e) {
                console.error('Error al obtener enlace del grupo:', e);
                await sock.sendMessage(jid, { text: '❌ No pude obtener el enlace de invitación del grupo. Asegúrate de que el bot es administrador.' });
            }
            break;

        case 'revoke':
            if (!isGroup(jid)) {
                await sock.sendMessage(jid, { text: 'Este comando solo puede usarse en grupos.' });
                return;
            }
            if (!isSenderAdmin) {
                await sock.sendMessage(jid, { text: 'Necesitas ser *administrador* del grupo para usar este comando.' });
                return;
            }
            if (!isBotAdmin) {
                await sock.sendMessage(jid, { text: 'Necesito ser *administrador* del grupo para revocar el enlace.' });
                return;
            }
            try {
                await sock.groupRevokeInvite(jid);
                await sock.sendMessage(jid, { text: '♻️ El enlace de invitación del grupo ha sido revocado. Se ha generado uno nuevo.' });
            } catch (e) {
                console.error('Error al revocar enlace del grupo:', e);
                await sock.sendMessage(jid, { text: '❌ No pude revocar el enlace de invitación del grupo. Asegúrate de que el bot es administrador.' });
            }
            break;

        case 'leave':
            if (!isGroup(jid)) {
                await sock.sendMessage(jid, { text: 'Este comando solo puede usarse en grupos.' });
                return;
            }
            if (!isSenderAdmin && !isOwner(sender)) {
                await sock.sendMessage(jid, { text: 'Necesitas ser *administrador* del grupo o el *creador* del bot para usar este comando.' });
                return;
            }
            await sock.sendMessage(jid, { text: '👋 ¡Adiós! Me despido de este grupo.' });
            try {
                await sock.groupLeave(jid);
            } catch (e) {
                console.error('Error al salir del grupo:', e);
                await sock.sendMessage(jid, { text: '❌ No pude salir del grupo.' });
            }
            break;

        case 'daily':
            if (!economyData[sender]) {
                economyData[sender] = { balance: 0, lastDaily: 0, lastWork: 0, lastSlut: 0, lastChest: 0 };
            }

            const lastDaily = economyData[sender].lastDaily || 0;
            const twentyFourHours = 24 * 60 * 60 * 1000;

            if (now - lastDaily < twentyFourHours) {
                const remainingTime = twentyFourHours - (now - lastDaily);
                const hours = Math.floor(remainingTime / (1000 * 60 * 60));
                const minutes = Math.floor((remainingTime % (1000 * 60 * 60)) / (1000 * 60));
                const seconds = Math.floor((remainingTime % (1000 * 60)) / 1000);
                await sock.sendMessage(jid, { text: `⏰ Ya reclamaste tu recompensa diaria. Vuelve en ${hours}h ${minutes}m ${seconds}s.` });
                return;
            }

            const dailyReward = Math.floor(Math.random() * 2000) + 1000;
            economyData[sender].balance += dailyReward;
            economyData[sender].lastDaily = now;
            saveEconomyData();
            await sock.sendMessage(jid, { text: `💰 ¡Has reclamado tu recompensa diaria de ${dailyReward} coins! Tu balance actual es: ${economyData[sender].balance} coins.` });
            break;

        case 'work':
        case 'w':
            if (!economyData[sender]) {
                economyData[sender] = { balance: 0, lastDaily: 0, lastWork: 0, lastSlut: 0, lastChest: 0 };
            }

            const lastWork = economyData[sender].lastWork || 0;
            const thirtyMinutes = 30 * 60 * 1000;

            if (now - lastWork < thirtyMinutes) {
                const remainingTime = thirtyMinutes - (now - lastWork);
                const minutes = Math.floor(remainingTime / (1000 * 60));
                const seconds = Math.floor((remainingTime % (1000 * 60)) / 1000);
                await sock.sendMessage(jid, { text: `⏰ Ya trabajaste recientemente. Vuelve en ${minutes}m ${seconds}s para trabajar de nuevo.` });
                return;
            }

            const workReward = Math.floor(Math.random() * 500) + 100;
            const workMessages = [
                'Trabajaste como programador y ganaste',
                'Vendiste chicles en la calle y ganaste',
                'Ayudaste a un anciano a cruzar la calle y te dio',
                'Repartiste volantes y conseguiste',
                'Trabajaste de mesero y obtuviste'
            ];
            const randomWorkMessage = workMessages[Math.floor(Math.random() * workMessages.length)];

            economyData[sender].balance += workReward;
            economyData[sender].lastWork = now;
            saveEconomyData();
            await sock.sendMessage(jid, { text: `💼 ${randomWorkMessage} ${workReward} coins. Tu balance actual es: ${economyData[sender].balance} coins.` });
            break;

        case 'slut':
            if (!economyData[sender]) {
                economyData[sender] = { balance: 0, lastDaily: 0, lastWork: 0, lastSlut: 0, lastChest: 0 };
            }

            const lastSlut = economyData[sender].lastSlut || 0;
            const fifteenMinutes = 15 * 60 * 1000;

            if (now - lastSlut < fifteenMinutes) {
                const remainingTime = fifteenMinutes - (now - lastSlut);
                const minutes = Math.floor(remainingTime / (1000 * 60));
                const seconds = Math.floor((remainingTime % (1000 * 60)) / 1000);
                await sock.sendMessage(jid, { text: `⏰ Ya te prostituiste recientemente. Vuelve en ${minutes}m ${seconds}s.` });
                return;
            }

            const slutReward = Math.floor(Math.random() * 300) + 50;
            const slutMessages = [
                'Te prostituiste y ganaste',
                'Conseguiste un cliente generoso y obtuviste',
                'Trabajaste en la calle y lograste',
                'Te pagaron bien por tus servicios y recibiste'
            ];
            const randomSlutMessage = slutMessages[Math.floor(Math.random() * slutMessages.length)];

            economyData[sender].balance += slutReward;
            economyData[sender].lastSlut = now;
            saveEconomyData();
            await sock.sendMessage(jid, { text: `💋 ${randomSlutMessage} ${slutReward} coins. Tu balance actual es: ${economyData[sender].balance} coins.` });
            break;

        case 'chest':
            if (!economyData[sender]) {
                economyData[sender] = { balance: 0, lastDaily: 0, lastWork: 0, lastSlut: 0, lastChest: 0 };
            }

            const lastChest = economyData[sender].lastChest || 0;
            const oneHour = 60 * 60 * 1000;

            if (now - lastChest < oneHour) {
                const remainingTime = oneHour - (now - lastChest);
                const minutes = Math.floor(remainingTime / (1000 * 60));
                const seconds = Math.floor((remainingTime % (1000 * 60)) / 1000);
                await sock.sendMessage(jid, { text: `⏰ Ya fuiste en búsqueda del tesoro recientemente. Vuelve en ${minutes}m ${seconds}s.` });
                return;
            }

            const chestReward = Math.floor(Math.random() * 1000) + 200;
            const chestMessages = [
                'Encontraste un cofre abandonado y dentro había',
                'Desenterraste un tesoro oculto y obtuviste',
                'Abriste un cofre misterioso y te llevaste',
                'Explorando ruinas antiguas, descubriste un cofre con'
            ];
            const randomChestMessage = chestMessages[Math.floor(Math.random() * chestMessages.length)];

            economyData[sender].balance += chestReward;
            economyData[sender].lastChest = now;
            saveEconomyData();
            await sock.sendMessage(jid, { text: `🏴‍☠️ ${randomChestMessage} ${chestReward} coins. Tu balance actual es: ${economyData[sender].balance} coins.` });
            break;

        case 'baltop':
            const sortedUsers = Object.entries(economyData).sort(([, a], [, b]) => b.balance - a.balance);
            let baltopMessage = '🏆 *Top 10 Usuarios con Más Coins:*\n\n';

            if (sortedUsers.length === 0) {
                baltopMessage += 'No hay usuarios registrados con coins todavía.';
            } else {
                for (let i = 0; i < Math.min(sortedUsers.length, 10); i++) {
                    const [userId, data] = sortedUsers[i];
                    const username = registeredUsers[userId]?.username || userId.split('@')[0];
                    baltopMessage += `${i + 1}. ${username}: ${data.balance} coins\n`;
                }
            }
            await sock.sendMessage(jid, { text: baltopMessage });
            break;

        case 'ytmp3':
            const ytLink = args[0];
            if (!ytLink || !ytdl.validateURL(ytLink)) {
                await sock.sendMessage(jid, { text: `Por favor, proporciona un enlace de YouTube válido. Ejemplo: ${PREFIX}ytmp3 https://www.youtube.com/watch?v=dQw4w9WgXcQ` });
                return;
            }
            try {
                await sock.sendMessage(jid, { text: '⏳ Descargando audio, esto puede tomar un momento...' });
                const audioStream = ytdl(ytLink, { filter: 'audioonly', quality: 'highestaudio' });
                
                const tempAudioPath = path.join(__dirname, '../data/temp_audio.mp3');

                ffmpeg()
                    .input(audioStream)
                    .audioBitrate('128k')
                    .format('mp3')
                    .output(tempAudioPath)
                    .on('end', async () => {
                        await sock.sendMessage(jid, { audio: readFileSync(tempAudioPath), mimetype: 'audio/mp4' });
                        unlinkSync(tempAudioPath);
                    })
                    .on('error', (err) => {
                        console.error('Error al convertir audio:', err);
                        sock.sendMessage(jid, { text: '❌ Ocurrió un error al procesar el audio de YouTube. Asegúrate de que el enlace es un video disponible.' });
                        unlinkSync(tempAudioPath);
                    })
                    .run();

            } catch (e) {
                console.error('Error al descargar YouTube MP3:', e);
                await sock.sendMessage(jid, { text: `❌ Ocurrió un error al descargar el audio de YouTube: ${e.message}` });
            }
            break;

        case 'mediafire':
            const mediafireLink = args[0];
            if (!mediafireLink || !mediafireLink.includes('mediafire.com')) {
                await sock.sendMessage(jid, { text: `Por favor, proporciona un enlace de MediaFire válido. Ejemplo: ${PREFIX}mediafire https://www.mediafire.com/file/abcdefg/mi_archivo.zip/file` });
                return;
            }
            try {
                await sock.sendMessage(jid, { text: '⏳ Obteniendo enlace de MediaFire, por favor espera...' });
                const response = await axiosInstance.get(mediafireLink);
                const $ = cheerio.load(response.data);
                const downloadLink = $('a#downloadButton').attr('href');
                const fileName = $('div.download_file_name').text().trim();
                const fileSize = $('div.download_file_size').text().trim();

                if (downloadLink) {
                    await sock.sendMessage(jid, { text: `✅ *Archivo de MediaFire encontrado:*\n\n*Nombre:* ${fileName}\n*Tamaño:* ${fileSize}\n*Enlace:* ${downloadLink}` });
                } else {
                    await sock.sendMessage(jid, { text: '❌ No pude encontrar el enlace de descarga en esa página de MediaFire. Asegúrate de que el enlace es directo a un archivo.' });
                }
            } catch (e) {
                console.error('Error al descargar MediaFire:', e);
                await sock.sendMessage(jid, { text: `❌ Ocurrió un error al descargar el archivo de MediaFire: ${e.message}` });
            }
            break;

        case 'mega':
            await sock.sendMessage(jid, { text: 'Este comando requiere una implementación más compleja. Para descargar archivos de Mega, podrías considerar usar una API o herramienta externa que soporte Mega.js o similar, lo cual está fuera del alcance de una implementación simple aquí.' });
            break;

        case 'igdl':
            const igLink = args[0];
            if (!igLink || !igLink.includes('instagram.com')) {
                await sock.sendMessage(jid, { text: `Por favor, proporciona un enlace de Instagram válido (publicación, reel, etc.). Ejemplo: ${PREFIX}igdl https://www.instagram.com/p/CgK7M6i_x1y/` });
                return;
            }
            try {
                await sock.sendMessage(jid, { text: '⏳ Descargando contenido de Instagram, esto puede tomar un momento...' });
                const result = await instagramdl(igLink);
                if (result && result.length > 0) {
                    for (const item of result) {
                        if (item.type === 'video') {
                            await sock.sendMessage(jid, { video: { url: item.url }, caption: 'Aquí está el video de Instagram:' });
                        } else if (item.type === 'image') {
                            await sock.sendMessage(jid, { image: { url: item.url }, caption: 'Aquí está la imagen de Instagram:' });
                        }
                    }
                } else {
                    await sock.sendMessage(jid, { text: '❌ No pude descargar el contenido de Instagram de ese enlace. Asegúrate de que la publicación es pública y válida.' });
                }
            } catch (e) {
                console.error('Error al descargar Instagram:', e);
                await sock.sendMessage(jid, { text: `❌ Ocurrió un error al descargar el contenido de Instagram: ${e.message}` });
            }
            break;

        case 'foro':
            await sock.sendMessage(jid, { text: '🌐 ¡Bienvenido al Foro de Scooby Doo! Puedes acceder aquí: [Enlace a tu foro]' });
            break;
        
        case 'pfp':
            const targetPfp = quotedParticipant;
            if (!targetPfp) {
                await sock.sendMessage(jid, { text: `Debes *citar* el mensaje del usuario o mencionarlo para obtener su foto de perfil. Ejemplo: ${PREFIX}pfp @usuario` });
                return;
            }
            try {
                const pfp = await sock.profilePictureUrl(targetPfp, 'image');
                await sock.sendMessage(jid, { image: { url: pfp }, caption: `Foto de perfil de @${targetPfp.split('@')[0]}` }, { mentions: [targetPfp] });
            } catch (e) {
                console.error('Error al obtener PFP:', e);
                await sock.sendMessage(jid, { text: `❌ No pude obtener la foto de perfil de @${targetPfp.split('@')[0]}, puede que no tenga una o sea privada.` }, { mentions: [targetPfp] });
            }
            break;

        case 'redeem':
            const redeemCode = args[0];
            if (!redeemCode) {
                await sock.sendMessage(jid, { text: `Por favor, proporciona un código para canjear. Ejemplo: ${PREFIX}redeem CODIGO123` });
                return;
            }
            await sock.sendMessage(jid, { text: `El comando ${PREFIX}redeem está pendiente de implementación. Por ahora, no hay códigos activos.` });
            break;

        case 'sticker':
            const quotedStickerMsg = quotedMessage;
            if (!quotedStickerMsg || !quotedStickerMsg.imageMessage) {
                await sock.sendMessage(jid, { text: 'Debes *citar* una imagen para convertirla en sticker.' });
                return;
            }

            try {
                await sock.sendMessage(jid, { text: '🔄 Convirtiendo imagen a sticker, por favor espera...' });
                const stream = await sock.downloadMediaMessage(quotedStickerMsg.imageMessage);
                const buffer = await new Promise((resolve, reject) => {
                    streamToBuffer(stream, (err, buf) => {
                        if (err) reject(err);
                        resolve(buf);
                    });
                });

                const tempInputPath = path.join(__dirname, '../data/input_sticker.png');
                const tempOutputPath = path.join(__dirname, '../data/output_sticker.webp');
                writeFileSync(tempInputPath, buffer);

                await new Promise((resolve, reject) => {
                    ffmpeg(tempInputPath)
                        .outputOptions([
                            '-vcodec', 'libwebp',
                            '-vf', 'scale=\'min(320,iw)\':\'min(320,ih)\':force_original_aspect_ratio=decrease,format=rgba,pad=320:320:\'(ow-iw)/2\':\'(oh-ih)/2\':color=0x00000000,setsar=1',
                            '-loop', '0',
                            '-metadata', 'image_title=ScoobyDooBot',
                            '-hide_banner',
                            '-loglevel', 'error'
                        ])
                        .toFormat('webp')
                        .on('end', () => resolve())
                        .on('error', (err) => reject(err))
                        .save(tempOutputPath);
                });
                
                await sock.sendMessage(jid, { sticker: readFileSync(tempOutputPath) });
                unlinkSync(tempInputPath);
                unlinkSync(tempOutputPath);

            } catch (e) {
                console.error('Error al crear sticker:', e);
                await sock.sendMessage(jid, { text: `❌ Ocurrió un error al convertir la imagen en sticker: ${e.message}` });
            }
            break;

        case 'toimg':
            const quotedToImgMsg = quotedMessage;
            if (!quotedToImgMsg || !quotedToImgMsg.stickerMessage) {
                await sock.sendMessage(jid, { text: 'Debes *citar* un sticker para convertirlo en imagen.' });
                return;
            }

            try {
                await sock.sendMessage(jid, { text: '🔄 Convirtiendo sticker a imagen, por favor espera...' });
                const stream = await sock.downloadMediaMessage(quotedToImgMsg.stickerMessage);
                const buffer = await new Promise((resolve, reject) => {
                    streamToBuffer(stream, (err, buf) => {
                        if (err) reject(err);
                        resolve(buf);
                    });
                });

                const tempInputPath = path.join(__dirname, '../data/input_toimg.webp');
                const tempOutputPath = path.join(__dirname, '../data/output_toimg.png');
                writeFileSync(tempInputPath, buffer);

                await new Promise((resolve, reject) => {
                    ffmpeg(tempInputPath)
                        .toFormat('png')
                        .on('end', () => resolve())
                        .on('error', (err) => reject(err))
                        .save(tempOutputPath);
                });
                
                await sock.sendMessage(jid, { image: readFileSync(tempOutputPath) });
                unlinkSync(tempInputPath);
                unlinkSync(tempOutputPath);

            } catch (e) {
                console.error('Error al convertir sticker a imagen:', e);
                await sock.sendMessage(jid, { text: `❌ Ocurrió un error al convertir el sticker en imagen: ${e.message}` });
            }
            break;

        default:
            await sock.sendMessage(jid, { text: `Comando *${commandName}* no reconocido. Usa *${PREFIX}help* para ver los comandos disponibles.` });
            break;
    }
};

module.exports = messageHandler;