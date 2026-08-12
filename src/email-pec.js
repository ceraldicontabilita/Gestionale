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
  if (address.address) return String(address.address).toLowerCase();
  return null;
}

function attachmentBuffer(attachment) {
  if (Buffer.isBuffer(attachment.content)) return attachment.content;
  if (attachment.content instanceof ArrayBuffer) return Buffer.from(attachment.content);
  if (ArrayBuffer.isView(attachment.content)) return Buffer.from(attachment.content.buffer, attachment.content.byteOffset, attachment.content.byteLength);
  if (typeof attachment.content === 'string') {
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

async function loadTrustedSenders(db, channel) {
  const rows = await db.collection('mittenti_email').find({
    canale: { $in: [channel, 'email', 'pec'] },
    attivo: { $ne: false }
  }).limit(500).toArray();
  return rows.map((row) => String(row.pattern || row.email || '').toLowerCase()).filter(Boolean);
}

function senderTrusted(address, patterns) {
  const value = String(address || '').toLowerCase();
  return patterns.some((pattern) => value.includes(pattern));
}

async function parseNestedMessage(attachment) {
  const name = String(attachment.filename || '').toLowerCase();
  if (attachment.mimeType !== 'message/rfc822' && !name.endsWith('.eml')) return null;
  const content = attachmentBuffer(attachment);
  if (!content.length) return null;
  try {
    const parsed = await PostalMime.parse(content, { attachmentEncoding: 'arraybuffer', maxNestingDepth: 64, maxHeadersSize: 2 * 1024 * 1024 });
    return {
      from: normalizeAddress(parsed.from),
      subject: parsed.subject || null,
      messageId: parsed.messageId || null,
      text: parsed.text || null
    };
  } catch {
    return null;
  }
}

async function persistMessage(db, message, parsed, { mailbox, uidValidity, trustedPatterns, now }) {
  const raw = Buffer.from(message.source || []);
  const rawHash = sha256(raw);
  const messageKey = `IMAP:${mailbox}:${uidValidity}:${message.uid}`;
  const outerFrom = normalizeAddress(parsed.from) || normalizeAddress(message.envelope?.from);
  const nestedCandidates = [];
  for (const attachment of parsed.attachments || []) {
    const nested = await parseNestedMessage(attachment);
    if (nested) nestedCandidates.push(nested);
  }
  const inner = nestedCandidates[0] || null;
  const effectiveFrom = inner?.from || outerFrom;
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
        fromOriginale: inner?.from || null,
        mittenteEffettivo: effectiveFrom,
        mittenteAttendibile: trusted,
        subjectEsterno: parsed.subject || message.envelope?.subject || null,
        subjectOriginale: inner?.subject || null,
        dataEmail: message.internalDate || message.envelope?.date || null,
        rawSha256: rawHash,
        rawGridFsId: rawStored.gridFsId,
        aggiornatoIl: now
      },
      $setOnInsert: { creatoIl: now }
    },
    { upsert: true }
  );

  let attachmentsNew = 0;
  let technical = 0;
  for (let index = 0; index < (parsed.attachments || []).length; index += 1) {
    const attachment = parsed.attachments[index];
    const content = attachmentBuffer(attachment);
    const hash = sha256(content);
    const filename = attachment.filename || `allegato-${index + 1}`;
    const tecnicoPec = isPecTechnicalFile(filename, attachment.mimeType);
    if (tecnicoPec) technical += 1;
    const stored = await storeOriginalOnce(db, content, {
      sha256: hash,
      filename,
      contentType: attachment.mimeType || 'application/octet-stream',
      metadata: { source: 'IMAP_ATTACHMENT', messageKey, index }
    });

    const sourceKey = `${messageKey}:ATT:${index}:${hash}`;
    const proposal = proposeType({
      filename,
      subject: inner?.subject || parsed.subject,
      text: inner?.text || parsed.text
    });
    const result = await db.collection('documenti_inbox').updateOne(
      { sourceKey },
      {
        $set: {
          sourceKey,
          sourceType: 'IMAP',
          sourceId: `${uidValidity}:${message.uid}:${index}`,
          nomeOriginale: filename,
          mimeType: attachment.mimeType || 'application/octet-stream',
          sha256: hash,
          gridFsId: stored.gridFsId,
          emailMessageKey: messageKey,
          emailFrom: effectiveFrom,
          emailSubject: inner?.subject || parsed.subject || null,
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

  return { attachments: (parsed.attachments || []).length, attachmentsNew, technical, trusted };
}

export function createEmailPecHandler({ config, logger = console }) {
  const mailbox = config.mailbox || 'INBOX';
  return async function emailPecScan({ db, checkpoint, now }) {
    const client = new ImapFlow({
      host: config.host,
      port: Number(config.port || 993),
      secure: config.secure !== false,
      auth: { user: config.user, pass: config.password },
      logger: false
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
    let maxUid = Number(checkpoint?.lastUid || 0);

    await client.connect();
    const lock = await client.getMailboxLock(mailbox);
    try {
      const uidValidity = String(client.mailbox?.uidValidity || '0');
      const sameMailboxGeneration = !checkpoint?.uidValidity || String(checkpoint.uidValidity) === uidValidity;
      const overlapUids = Number(config.overlapUids || 50);
      const fromUid = sameMailboxGeneration && checkpoint?.lastUid
        ? Math.max(1, Number(checkpoint.lastUid) - overlapUids)
        : 1;
      const uids = await client.search({ uid: `${fromUid}:*` }, { uid: true });
      const maxMessages = Number(config.maxMessages || 200);
      const selected = uids.slice(-maxMessages);
      const fetched = selected.length
        ? await client.fetchAll(selected, { uid: true, envelope: true, internalDate: true, source: true }, { uid: true })
        : [];

      for (const message of fetched) {
        const parsed = await PostalMime.parse(message.source, {
          attachmentEncoding: 'arraybuffer',
          maxNestingDepth: 64,
          maxHeadersSize: 2 * 1024 * 1024,
          rfc822Attachments: true,
          forceRfc822Attachments: true
        });
        const saved = await persistMessage(db, message, parsed, { mailbox, uidValidity, trustedPatterns, now });
        messages += 1;
        attachments += saved.attachments;
        attachmentsNew += saved.attachmentsNew;
        technical += saved.technical;
        if (saved.trusted) trustedMessages += 1;
        maxUid = Math.max(maxUid, Number(message.uid || 0));
      }

      return {
        counts: { messages, trustedMessages, attachments, attachmentsNew, technical, errors: 0 },
        checkpoint: { uidValidity, lastUid: maxUid, mailbox },
        metadata: { trustedPatterns: trustedPatterns.length }
      };
    } finally {
      lock.release();
      await client.logout().catch(() => {});
      logger.info?.(`[email-pec] messaggi=${messages} allegatiNuovi=${attachmentsNew}`);
    }
  };
}
