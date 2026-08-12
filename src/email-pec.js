import crypto from 'node:crypto';
import { ImapFlow } from 'imapflow';
import PostalMime from 'postal-mime';
import { storeOriginalOnce } from './blob-store.js';

function sha256(content) {
  return crypto.createHash('sha256').update(content).digest('hex');
}

function normalizeAddress(address) {
  if (!address) return null;
  if (Array.isArray(address)) return normalizeAddress(address[0]);
  if (address.address) return String(address.address).trim().toLowerCase();
  if (typeof address === 'string') {
    const match = address.match(/<([^>]+)>/);
    return String(match?.[1] || address).trim().toLowerCase();
  }
  return null;
}

function attachmentBuffer(attachment) {
  if (Buffer.isBuffer(attachment?.content)) return attachment.content;
  if (attachment?.content instanceof ArrayBuffer) return Buffer.from(attachment.content);
  if (ArrayBuffer.isView(attachment?.content)) return Buffer.from(attachment.content.buffer, attachment.content.byteOffset, attachment.content.byteLength);
  if (typeof attachment?.content === 'string') {
    return attachment.encoding === 'base64' ? Buffer.from(attachment.content, 'base64') : Buffer.from(attachment.content);
  }
  return Buffer.alloc(0);
}

function isPecTechnicalFile(name, mimeType) {
  const lower = String(name || '').toLowerCase();
  return lower === 'daticert.xml' || lower === 'postacert.eml' || lower.endsWith('.p7s') || lower.endsWith('.p7m') || mimeType === 'message/rfc822';
}

function proposeType({ filename, subject, text }) {
  const haystack = `${filename || ''} ${subject || ''} ${text || ''}`.toLowerCase();
  if (/quietanza.{0,20}f24|f24.{0,20}quietanza/.test(haystack)) return 'F24_QUIETANZA';
  if (/\bf24\b/.test(haystack)) return 'F24';
  if (/cartella di pagamento/.test(haystack)) return 'CARTELLA_PAGAMENTO';
  if (/avviso di addebito/.test(haystack) && /inps/.test(haystack)) return 'AVVISO_ADDEBITO_INPS';
  if (/intimazione/.test(haystack)) return 'INTIMAZIONE';
  if (/rateizzazione|piano di ammortamento/.test(haystack)) return 'RATEIZZAZIONE';
  if (/cedolino|busta paga/.test(haystack)) return 'CEDOLINO';
  if (/pagopa/.test(haystack)) return 'PAGOPA';
  return null;
}

function normalizeTrustedPattern(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return null;
  if (raw.startsWith('domain:')) return { type: 'DOMAIN', value: raw.slice(7).replace(/^@/, '') };
  if (raw.startsWith('*@') || raw.startsWith('@')) return { type: 'DOMAIN', value: raw.replace(/^\*?@/, '') };
  if (/^[^\s@]+@[^\s@]+$/.test(raw)) return { type: 'EMAIL', value: raw };
  return null;
}

async function loadTrustedSenders(db, channel) {
  const rows = await db.collection('mittenti_email').find({
    canale: { $in: [channel, 'email', 'pec'] },
    attivo: { $ne: false }
  }).limit(500).toArray();
  return rows.map((row) => normalizeTrustedPattern(row.pattern || row.email)).filter(Boolean);
}

export function senderTrusted(address, patterns) {
  const value = normalizeAddress(address);
  if (!value) return false;
  const domain = value.split('@').at(-1);
  return patterns.some((pattern) => pattern.type === 'EMAIL'
    ? value === pattern.value
    : pattern.type === 'DOMAIN' && domain === pattern.value);
}

function decodeXml(value) {
  return String(value || '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").trim();
}

function xmlTag(text, name) {
  const match = String(text).match(new RegExp(`<(?:[A-Za-z0-9_-]+:)?${name}[^>]*>([\\s\\S]*?)<\\/(?:[A-Za-z0-9_-]+:)?${name}>`, 'i'));
  return match ? decodeXml(match[1].replace(/<[^>]+>/g, ' ')) : null;
}

export function parseDaticertXml(content) {
  const text = Buffer.isBuffer(content) ? content.toString('utf8') : String(content || '');
  return {
    mittente: normalizeAddress(xmlTag(text, 'mittente')),
    destinatario: normalizeAddress(xmlTag(text, 'destinatario') || xmlTag(text, 'destinatari')),
    oggetto: xmlTag(text, 'oggetto'),
    identificativo: xmlTag(text, 'identificativo'),
    tipoRicevuta: xmlTag(text, 'tipo') || xmlTag(text, 'tipoRicevuta')
  };
}

async function parseMime(content) {
  return PostalMime.parse(content, {
    attachmentEncoding: 'arraybuffer',
    maxNestingDepth: 64,
    maxHeadersSize: 2 * 1024 * 1024,
    rfc822Attachments: true,
    forceRfc822Attachments: true
  });
}

async function parseNestedMessage(attachment) {
  const name = String(attachment.filename || '').toLowerCase();
  if (attachment.mimeType !== 'message/rfc822' && !name.endsWith('.eml')) return null;
  const content = attachmentBuffer(attachment);
  if (!content.length) return null;
  try {
    const parsed = await parseMime(content);
    return {
      filename: attachment.filename || null,
      from: normalizeAddress(parsed.from),
      subject: parsed.subject || null,
      messageId: parsed.messageId || null,
      text: parsed.text || null,
      parsed,
      content
    };
  } catch {
    return null;
  }
}

export function selectImapUids(uids, checkpoint = {}, { maxMessages = 200, overlapUids = 50, uidValidity = '0' } = {}) {
  const ordered = [...new Set((uids || []).map(Number).filter((uid) => Number.isInteger(uid) && uid > 0))].sort((a, b) => a - b);
  const sameGeneration = checkpoint.uidValidity && String(checkpoint.uidValidity) === String(uidValidity);
  const lastUid = sameGeneration ? Number(checkpoint.lastUid || 0) : 0;
  const overlap = lastUid > 0 ? ordered.filter((uid) => uid <= lastUid).slice(-Math.max(0, overlapUids)) : [];
  const fresh = ordered.filter((uid) => uid > lastUid).slice(0, Math.max(1, maxMessages));
  return {
    selected: [...new Set([...overlap, ...fresh])].sort((a, b) => a - b),
    lastUid,
    reset: !sameGeneration && Boolean(checkpoint.uidValidity),
    morePending: ordered.some((uid) => uid > (fresh.at(-1) || lastUid))
  };
}

async function persistMessage(db, message, parsed, { mailbox, uidValidity, trustedPatterns, now, maxMessageBytes, maxAttachmentBytes }) {
  const raw = Buffer.from(message.source || []);
  if (!raw.length) throw Object.assign(new Error('Messaggio IMAP privo della sorgente originale'), { code: 'IMAP_SOURCE_EMPTY' });
  if (raw.length > maxMessageBytes) throw Object.assign(new Error('Messaggio IMAP oltre il limite configurato'), { code: 'IMAP_MESSAGE_TOO_LARGE' });
  const rawHash = sha256(raw);
  const messageKey = `IMAP:${mailbox}:${uidValidity}:${message.uid}`;
  const outerFrom = normalizeAddress(parsed.from) || normalizeAddress(message.envelope?.from);

  let daticert = null;
  const nestedCandidates = [];
  for (const attachment of parsed.attachments || []) {
    if (String(attachment.filename || '').toLowerCase() === 'daticert.xml') daticert = parseDaticertXml(attachmentBuffer(attachment));
    const nested = await parseNestedMessage(attachment);
    if (nested) nestedCandidates.push(nested);
  }
  const inner = nestedCandidates.find((item) => String(item.filename || '').toLowerCase() === 'postacert.eml') || nestedCandidates[0] || null;
  const effectiveFrom = inner?.from || daticert?.mittente || outerFrom;
  const effectiveSubject = inner?.subject || daticert?.oggetto || parsed.subject || message.envelope?.subject || null;
  const trusted = senderTrusted(effectiveFrom, trustedPatterns) || senderTrusted(outerFrom, trustedPatterns);

  const rawStored = await storeOriginalOnce(db, raw, {
    sha256: rawHash,
    filename: `${message.uid}.eml`,
    contentType: 'message/rfc822',
    metadata: { source: 'IMAP', mailbox, uid: message.uid, uidValidity: String(uidValidity) }
  });

  await db.collection('email_messaggi').updateOne(
    { sourceKey: messageKey },
    {
      $set: {
        sourceKey: messageKey,
        mailbox,
        uid: message.uid,
        uidValidity: String(uidValidity),
        messageId: inner?.messageId || parsed.messageId || message.envelope?.messageId || null,
        fromEsterno: outerFrom,
        fromOriginale: inner?.from || daticert?.mittente || null,
        mittenteEffettivo: effectiveFrom,
        mittenteAttendibile: trusted,
        subjectEsterno: parsed.subject || message.envelope?.subject || null,
        subjectOriginale: effectiveSubject,
        identificativoPec: daticert?.identificativo || null,
        datiCert: daticert,
        dataEmail: message.internalDate || message.envelope?.date || null,
        rawSha256: rawHash,
        rawGridFsId: rawStored.gridFsId,
        aggiornatoIl: now
      },
      $setOnInsert: { creatoIl: now }
    },
    { upsert: true }
  );

  const candidates = [];
  for (let index = 0; index < (parsed.attachments || []).length; index += 1) {
    candidates.push({ attachment: parsed.attachments[index], origin: 'OUTER', index });
  }
  for (let index = 0; index < (inner?.parsed?.attachments || []).length; index += 1) {
    candidates.push({ attachment: inner.parsed.attachments[index], origin: 'INNER', index });
  }

  const seenHashes = new Set();
  let attachmentsNew = 0;
  let technical = 0;
  let total = 0;
  for (const candidate of candidates) {
    const attachment = candidate.attachment;
    const content = attachmentBuffer(attachment);
    if (!content.length) continue;
    if (content.length > maxAttachmentBytes) throw Object.assign(new Error(`Allegato oltre il limite: ${attachment.filename || candidate.index}`), { code: 'IMAP_ATTACHMENT_TOO_LARGE' });
    const hash = sha256(content);
    if (seenHashes.has(hash)) continue;
    seenHashes.add(hash);
    total += 1;
    const filename = attachment.filename || `allegato-${candidate.origin.toLowerCase()}-${candidate.index + 1}`;
    const tecnicoPec = isPecTechnicalFile(filename, attachment.mimeType);
    if (tecnicoPec) technical += 1;
    const stored = await storeOriginalOnce(db, content, {
      sha256: hash,
      filename,
      contentType: attachment.mimeType || 'application/octet-stream',
      metadata: { source: 'IMAP_ATTACHMENT', messageKey, origin: candidate.origin, index: candidate.index }
    });
    const sourceKey = `${messageKey}:ATT:${hash}`;
    const proposal = proposeType({ filename, subject: effectiveSubject, text: inner?.text || parsed.text });
    const result = await db.collection('documenti_inbox').updateOne(
      { sourceKey },
      {
        $set: {
          sourceKey,
          sourceType: 'IMAP',
          sourceId: `${uidValidity}:${message.uid}:${candidate.origin}:${candidate.index}`,
          nomeOriginale: filename,
          mimeType: attachment.mimeType || 'application/octet-stream',
          dimensione: content.length,
          sha256: hash,
          gridFsId: stored.gridFsId,
          emailMessageKey: messageKey,
          emailFrom: effectiveFrom,
          emailSubject: effectiveSubject,
          mittenteAttendibile: trusted,
          tecnicoPec,
          propostaTipo: proposal,
          stato: tecnicoPec ? 'TECNICO_PEC' : (proposal ? 'DA_VERIFICARE' : 'DA_CLASSIFICARE'),
          aggiornatoIl: now
        },
        $setOnInsert: { creatoIl: now }
      },
      { upsert: true }
    );
    if (result.upsertedCount) attachmentsNew += 1;
  }

  return { attachments: total, attachmentsNew, technical, trusted };
}

export function createEmailPecHandler({ config, logger = console }) {
  const mailbox = config.mailbox || 'INBOX';
  const maxMessages = Math.max(1, Number(config.maxMessages || 200));
  const overlapUids = Math.max(0, Number(config.overlapUids || 50));
  const maxMessageBytes = Math.max(1024 * 1024, Number(config.maxMessageBytes || 50 * 1024 * 1024));
  const maxAttachmentBytes = Math.max(1024 * 1024, Number(config.maxAttachmentBytes || maxMessageBytes));

  return async function emailPecScan({ db, checkpoint, now }) {
    const client = new ImapFlow({
      host: config.host,
      port: Number(config.port || 993),
      secure: config.secure !== false,
      auth: { user: config.user, pass: config.password },
      logger: false,
      socketTimeout: Number(config.socketTimeout || 120_000),
      greetingTimeout: Number(config.greetingTimeout || 30_000)
    });

    await Promise.all([
      db.collection('email_messaggi').createIndex({ sourceKey: 1 }, { unique: true }),
      db.collection('documenti_inbox').createIndex({ sourceKey: 1 }, { unique: true })
    ]);

    const trustedPatterns = await loadTrustedSenders(db, String(config.channel || 'pec').toLowerCase());
    let messages = 0;
    let attachments = 0;
    let attachmentsNew = 0;
    let technical = 0;
    let trustedMessages = 0;
    const errors = [];

    await client.connect();
    const lock = await client.getMailboxLock(mailbox);
    try {
      const uidValidity = String(client.mailbox?.uidValidity || '0');
      const uids = await client.search({ uid: '1:*' }, { uid: true });
      const selection = selectImapUids(uids, checkpoint || {}, { maxMessages, overlapUids, uidValidity });
      let maxUid = selection.lastUid;
      if (selection.selected.length) {
        const range = selection.selected.join(',');
        for await (const message of client.fetch(range, { uid: true, envelope: true, internalDate: true, source: true, size: true }, { uid: true })) {
          try {
            if (Number(message.size || 0) > maxMessageBytes) throw Object.assign(new Error('Messaggio IMAP oltre il limite configurato'), { code: 'IMAP_MESSAGE_TOO_LARGE' });
            const parsed = await parseMime(message.source);
            const saved = await persistMessage(db, message, parsed, {
              mailbox,
              uidValidity,
              trustedPatterns,
              now,
              maxMessageBytes,
              maxAttachmentBytes
            });
            messages += 1;
            attachments += saved.attachments;
            attachmentsNew += saved.attachmentsNew;
            technical += saved.technical;
            if (saved.trusted) trustedMessages += 1;
            maxUid = Math.max(maxUid, Number(message.uid || 0));
          } catch (error) {
            errors.push({ code: error.code || 'IMAP_MESSAGE_FAILED', message: error.message, reference: String(message.uid || '') });
          }
        }
      }

      return {
        counts: { messages, trustedMessages, attachments, attachmentsNew, technical, errors: errors.length },
        errors,
        checkpoint: {
          uidValidity,
          lastUid: maxUid,
          mailbox,
          backfillComplete: !selection.morePending,
          generationResetAt: selection.reset ? now.toISOString() : checkpoint?.generationResetAt || null
        },
        metadata: { trustedPatterns: trustedPatterns.length, selected: selection.selected.length, morePending: selection.morePending }
      };
    } finally {
      lock.release();
      await client.logout().catch(() => {});
      logger.info?.(`[email-pec] messaggi=${messages} allegatiNuovi=${attachmentsNew} errori=${errors.length}`);
    }
  };
}
